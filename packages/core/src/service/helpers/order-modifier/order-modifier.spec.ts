// eslint-disable-next-line import/order
import { Test } from '@nestjs/testing';
import { HistoryEntryType, ModifyOrderInput } from '@vendure/common/lib/generated-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderModifier } from './order-modifier';

import { RequestContext } from '../../../api/common/request-context';
import { EntityNotFoundError, InternalServerError, UserInputError } from '../../../common/error/errors';
import {
    CancelActiveOrderError,
    CouponCodeInvalidError,
    EmptyOrderLineSelectionError,
    MultipleOrderError,
    NoChangesSpecifiedError,
    OrderModificationStateError,
    RefundPaymentIdMissingError,
    RefundStateTransitionError,
} from '../../../common/error/generated-graphql-admin-errors';
import {
    IneligibleShippingMethodError,
    InsufficientStockError,
    NegativeQuantityError,
    OrderLimitError,
} from '../../../common/error/generated-graphql-shop-errors';
import { ensureConfigLoaded } from '../../../config/config-helpers';
import { ConfigService } from '../../../config/config.service';
import { MockConfigService } from '../../../config/config.service.mock';
import { CustomFieldConfig } from '../../../config/custom-field/custom-field-types';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { Customer } from '../../../entity/customer/customer.entity';
import { OrderModificationLine } from '../../../entity/order-line-reference/order-modification-line.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { OrderModification } from '../../../entity/order-modification/order-modification.entity';
import { Order } from '../../../entity/order/order.entity';
import { Payment } from '../../../entity/payment/payment.entity';
import { ProductVariant } from '../../../entity/product-variant/product-variant.entity';
import { Product } from '../../../entity/product/product.entity';
import { Refund } from '../../../entity/refund/refund.entity';
import { Surcharge } from '../../../entity/surcharge/surcharge.entity';
import { TaxCategory } from '../../../entity/tax-category/tax-category.entity';
import { OrderEvent } from '../../../event-bus';
import { EventBus } from '../../../event-bus/event-bus';
import { OrderLineEvent } from '../../../event-bus/events/order-line-event';
import { createOrderFromLines } from '../../../testing/order-test-utils';
import { CountryService } from '../../services/country.service';
import { HistoryService } from '../../services/history.service';
import { PaymentService } from '../../services/payment.service';
import { ProductVariantService } from '../../services/product-variant.service';
import { PromotionService } from '../../services/promotion.service';
import { StockMovementService } from '../../services/stock-movement.service';
import { CustomFieldRelationService } from '../custom-field-relation/custom-field-relation.service';
import { OrderCalculator } from '../order-calculator/order-calculator';
import { ShippingCalculator } from '../shipping-calculator/shipping-calculator';
import { TranslatorService } from '../translator/translator.service';

/**
 * Stands in for a TypeORM Repository. `save` assigns an id to new entities and returns them; the
 * `relation()` chain records links made to the entity so that the tests can assert on them.
 */
function createFakeRepository(prefix: string) {
    let nextId = 1;
    const saved: any[] = [];
    const relationOps: Array<{ relation: string; of: any; op: 'add' | 'set'; value: any }> = [];
    return {
        saved,
        relationOps,
        save: vi.fn(async (entity: any) => {
            if (!Array.isArray(entity) && entity.id == null) {
                entity.id = `${prefix}-${nextId++}`;
            }
            saved.push(entity);
            return entity;
        }),
        update: vi.fn().mockResolvedValue(undefined),
        find: vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockResolvedValue(null),
        createQueryBuilder: () => ({
            relation: (relation: string) => ({
                of: (of: any) => ({
                    add: async (value: any) => {
                        relationOps.push({ relation, of, op: 'add', value });
                    },
                    set: async (value: any) => {
                        relationOps.push({ relation, of, op: 'set', value });
                    },
                }),
            }),
        }),
    };
}

type FakeRepository = ReturnType<typeof createFakeRepository>;

describe('OrderModifier', () => {
    let orderModifier: OrderModifier;
    let mockConfigService: MockConfigService;
    let repos: Record<string, FakeRepository>;
    let connection: {
        getRepository: ReturnType<typeof vi.fn>;
        getEntityOrThrow: ReturnType<typeof vi.fn>;
        findOneInChannel: ReturnType<typeof vi.fn>;
    };
    let orderCalculator: {
        applyPriceAdjustments: ReturnType<typeof vi.fn>;
        calculateOrderTotals: ReturnType<typeof vi.fn>;
    };
    let paymentService: { createRefund: ReturnType<typeof vi.fn> };
    let countryService: { findOneByCode: ReturnType<typeof vi.fn> };
    let stockMovementService: {
        createAllocationsForOrderLines: ReturnType<typeof vi.fn>;
        createCancellationsForOrderLines: ReturnType<typeof vi.fn>;
        createReleasesForOrderLines: ReturnType<typeof vi.fn>;
    };
    let productVariantService: {
        getSaleableStockLevel: ReturnType<typeof vi.fn>;
        applyChannelPriceAndTax: ReturnType<typeof vi.fn>;
    };
    let customFieldRelationService: { updateRelations: ReturnType<typeof vi.fn> };
    let promotionService: {
        validateCouponCode: ReturnType<typeof vi.fn>;
        getActivePromotionsInChannel: ReturnType<typeof vi.fn>;
        getActivePromotionsOnOrder: ReturnType<typeof vi.fn>;
        runPromotionSideEffects: ReturnType<typeof vi.fn>;
    };
    let eventBus: { publish: ReturnType<typeof vi.fn> };
    let shippingCalculator: { getMethodIfEligible: ReturnType<typeof vi.fn> };
    let historyService: { createHistoryEntryForOrder: ReturnType<typeof vi.fn> };

    const ctx = new RequestContext({
        apiType: 'admin',
        channel: new Channel({ id: 1, pricesIncludeTax: false }),
        authorizedAsOwnerOnly: false,
        isAuthorized: true,
    });

    beforeAll(async () => {
        await ensureConfigLoaded();
    });

    beforeEach(async () => {
        repos = {
            Order: createFakeRepository('order'),
            OrderLine: createFakeRepository('line'),
            OrderModification: createFakeRepository('modification'),
            OrderModificationLine: createFakeRepository('modification-line'),
            Surcharge: createFakeRepository('surcharge'),
            ShippingLine: createFakeRepository('shipping-line'),
            Payment: createFakeRepository('payment'),
        };
        connection = {
            getRepository: vi.fn((_ctx: RequestContext, entity: { name: string }) => repos[entity.name]),
            getEntityOrThrow: vi.fn(),
            findOneInChannel: vi.fn(),
        };
        orderCalculator = {
            applyPriceAdjustments: vi.fn(async (_ctx: RequestContext, order: Order) => order),
            calculateOrderTotals: vi.fn(),
        };
        paymentService = { createRefund: vi.fn() };
        countryService = {
            findOneByCode: vi.fn(async (_ctx: RequestContext, code: string) => ({ name: `Country ${code}` })),
        };
        stockMovementService = {
            createAllocationsForOrderLines: vi.fn().mockResolvedValue([]),
            createCancellationsForOrderLines: vi.fn().mockResolvedValue([]),
            createReleasesForOrderLines: vi.fn().mockResolvedValue([]),
        };
        productVariantService = {
            getSaleableStockLevel: vi.fn().mockResolvedValue(100),
            applyChannelPriceAndTax: vi.fn(async (variant: ProductVariant) => variant),
        };
        customFieldRelationService = { updateRelations: vi.fn().mockResolvedValue(undefined) };
        promotionService = {
            validateCouponCode: vi.fn(),
            getActivePromotionsInChannel: vi.fn().mockResolvedValue([]),
            getActivePromotionsOnOrder: vi.fn().mockResolvedValue([]),
            runPromotionSideEffects: vi.fn().mockResolvedValue(undefined),
        };
        eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
        shippingCalculator = { getMethodIfEligible: vi.fn() };
        historyService = { createHistoryEntryForOrder: vi.fn().mockResolvedValue(undefined) };

        const module = await Test.createTestingModule({
            providers: [
                OrderModifier,
                { provide: ConfigService, useClass: MockConfigService },
                { provide: TransactionalConnection, useValue: connection },
                { provide: OrderCalculator, useValue: orderCalculator },
                { provide: PaymentService, useValue: paymentService },
                { provide: CountryService, useValue: countryService },
                { provide: StockMovementService, useValue: stockMovementService },
                { provide: ProductVariantService, useValue: productVariantService },
                { provide: CustomFieldRelationService, useValue: customFieldRelationService },
                { provide: PromotionService, useValue: promotionService },
                { provide: EventBus, useValue: eventBus },
                { provide: ShippingCalculator, useValue: shippingCalculator },
                { provide: HistoryService, useValue: historyService },
                { provide: TranslatorService, useValue: {} },
            ],
        }).compile();
        mockConfigService = module.get<ConfigService, MockConfigService>(ConfigService);
        mockConfigService.orderOptions = {
            orderItemsLimit: 999,
            orderSellerStrategy: {},
            orderItemPriceCalculationStrategy: {
                calculateUnitPrice: vi.fn(async (_ctx: RequestContext, variant: ProductVariant) => ({
                    price: variant.listPrice,
                    priceIncludesTax: variant.listPriceIncludesTax,
                })),
            },
        };
        mockConfigService.customFields = { OrderLine: [] as CustomFieldConfig[] };
        orderModifier = module.get(OrderModifier);
    });

    function setOrderLineCustomFields(
        defs: Array<Partial<CustomFieldConfig> & { name: string; type: string }>,
    ) {
        mockConfigService.customFields = { OrderLine: defs as CustomFieldConfig[] };
    }

    describe('constrainQuantityToSaleable()', () => {
        const variant = new ProductVariant({ id: 1 });

        it('returns the requested quantity when stock is sufficient', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 5)).toBe(5);
        });

        it('adds the existing line quantity to the requested quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 3, 4)).toBe(7);
        });

        it('caps the quantity to the saleable stock level', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(4);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 10)).toBe(4);
        });

        it('caps the addition to what remains after the existing line quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(6);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 10, 4)).toBe(2);
        });

        it('accounts for the same variant in other order lines', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(6);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 10, 1, 3)).toBe(2);
        });

        it('never returns a negative quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(2);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 1, 5)).toBe(0);
        });
    });

    describe('getExistingOrderLine()', () => {
        it('returns the line matching the variant id when no custom fields are configured', async () => {
            const order = createOrderFromLines([
                { lineId: 1, quantity: 1, productVariantId: 100 },
                { lineId: 2, quantity: 1, productVariantId: 200 },
            ]);
            order.lines.forEach(l => (l.productVariantId = l.productVariant.id));

            const result = await orderModifier.getExistingOrderLine(ctx, order, 200);

            expect(result).toBe(order.lines[1]);
        });

        it('returns undefined when no line has the variant', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
            order.lines[0].productVariantId = 100;

            expect(await orderModifier.getExistingOrderLine(ctx, order, 300)).toBeUndefined();
        });

        describe('with custom fields', () => {
            function orderWithLine(customFields: any): Order {
                const order = createOrderFromLines([
                    { lineId: 1, quantity: 1, productVariantId: 100, customFields },
                ]);
                order.lines[0].productVariantId = 100;
                return order;
            }

            it('matches when the custom field values are equal', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string' }]);
                const order = orderWithLine({ note: 'gift' });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, { note: 'gift' });

                expect(result).toBe(order.lines[0]);
            });

            it('does not match when the custom field values differ', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string' }]);
                const order = orderWithLine({ note: 'gift' });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, { note: 'other' });

                expect(result).toBeUndefined();
            });

            it('treats an undefined input as matching a null existing value', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string' }]);
                const order = orderWithLine({ note: null });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {});

                expect(result).toBe(order.lines[0]);
            });

            it('treats an undefined input as matching the default value', async () => {
                setOrderLineCustomFields([{ name: 'gift', type: 'boolean', defaultValue: false }]);
                const order = orderWithLine({ gift: false });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {});

                expect(result).toBe(order.lines[0]);
            });

            it('coerces numeric boolean columns before comparing', async () => {
                setOrderLineCustomFields([{ name: 'gift', type: 'boolean' }]);
                const order = orderWithLine({ gift: 1 });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, { gift: true });

                expect(result).toBe(order.lines[0]);
            });

            it('matches a null input against a line whose custom fields are all unset', async () => {
                setOrderLineCustomFields([
                    { name: 'note', type: 'string' },
                    { name: 'tags', type: 'string', list: true },
                ]);
                const order = orderWithLine({ note: null, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBe(order.lines[0]);
            });

            it('matches a null input against a line whose custom fields equal their defaults', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string', defaultValue: 'none' }]);
                const order = orderWithLine({ note: 'none' });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBe(order.lines[0]);
            });

            it('does not match a null input against a line with a set custom field', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string' }]);
                const order = orderWithLine({ note: 'gift' });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBeUndefined();
            });

            it('does not match a null input against a line whose value differs from the default', async () => {
                setOrderLineCustomFields([{ name: 'note', type: 'string', defaultValue: 'none' }]);
                const order = orderWithLine({ note: 'gift' });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBeUndefined();
            });

            it('loads relation custom fields from the DB and compares by id', async () => {
                setOrderLineCustomFields([{ name: 'engraving', type: 'relation', entity: Product }]);
                const order = orderWithLine({});
                repos.OrderLine.findOne.mockResolvedValue(
                    new OrderLine({ id: 1, customFields: { engraving: { id: 'p-1' } } }),
                );

                const match = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engravingId: 'p-1',
                });
                const mismatch = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engravingId: 'p-2',
                });

                expect(match).toBe(order.lines[0]);
                expect(mismatch).toBeUndefined();
                expect(repos.OrderLine.findOne).toHaveBeenCalledWith({
                    where: { id: 1 },
                    relations: ['customFields.engraving'],
                });
            });

            it('compares list relation custom fields as sets of ids', async () => {
                setOrderLineCustomFields([{ name: 'addons', type: 'relation', list: true, entity: Product }]);
                const order = orderWithLine({});
                repos.OrderLine.findOne.mockResolvedValue(
                    new OrderLine({ id: 1, customFields: { addons: [{ id: 'b' }, { id: 'a' }] } }),
                );

                const match = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    addonsIds: ['a', 'b'],
                });
                const mismatch = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    addonsIds: ['a'],
                });

                expect(match).toBe(order.lines[0]);
                expect(mismatch).toBeUndefined();
            });
        });
    });

    describe('getOrCreateOrderLine()', () => {
        it('returns the existing line without touching the DB', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
            order.lines[0].productVariantId = 100;

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100);

            expect(result).toBe(order.lines[0]);
            expect(connection.findOneInChannel).not.toHaveBeenCalled();
            expect(repos.OrderLine.save).not.toHaveBeenCalled();
        });

        it('creates, links and announces a new line when none matches', async () => {
            const order = new Order({ id: 5, lines: [] });
            const variant = new ProductVariant({
                id: 100,
                listPrice: 1200,
                listPriceIncludesTax: true,
                featuredAssetId: 'asset-1',
                taxCategory: new TaxCategory({ id: 'tc' }),
                product: new Product({ id: 1 }),
            });
            connection.findOneInChannel.mockResolvedValue(variant);

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100, { note: 'x' });

            expect(result).toBeInstanceOf(OrderLine);
            expect(result.productVariant).toBe(variant);
            expect(result.listPrice).toBe(1200);
            expect(result.listPriceIncludesTax).toBe(true);
            expect(result.taxCategory).toBe(variant.taxCategory);
            expect(result.featuredAsset).toEqual({ id: 'asset-1' });
            expect(result.customFields).toEqual({ note: 'x' });
            expect(result.quantity).toBe(0);
            expect(order.lines).toEqual([result]);
            expect(productVariantService.applyChannelPriceAndTax).toHaveBeenCalledWith(variant, ctx, order);
            expect(customFieldRelationService.updateRelations).toHaveBeenCalledWith(
                ctx,
                OrderLine,
                { customFields: { note: 'x' } },
                result,
            );
            expect(repos.Order.relationOps).toEqual([
                { relation: 'lines', of: order, op: 'add', value: result },
            ]);
            const event = eventBus.publish.mock.calls[0][0] as OrderLineEvent;
            expect(event).toBeInstanceOf(OrderLineEvent);
            expect(event.type).toBe('created');
            expect(event.orderLine).toBe(result);
        });

        it('falls back to the product featured asset', async () => {
            const order = new Order({ id: 5, lines: [] });
            connection.findOneInChannel.mockResolvedValue(
                new ProductVariant({
                    id: 100,
                    product: new Product({ id: 1, featuredAssetId: 'product-asset' }),
                }),
            );

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100);

            expect(result.featuredAsset).toEqual({ id: 'product-asset' });
        });

        it('sets the seller channel when the OrderSellerStrategy provides one', async () => {
            const sellerChannel = new Channel({ id: 9 });
            mockConfigService.orderOptions.orderSellerStrategy = {
                setOrderLineSellerChannel: vi.fn().mockResolvedValue(sellerChannel),
            };
            const order = new Order({ id: 5, lines: [] });
            connection.findOneInChannel.mockResolvedValue(
                new ProductVariant({ id: 100, product: new Product({ id: 1 }) }),
            );

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100);

            expect(result.sellerChannel).toBe(sellerChannel);
            expect(repos.OrderLine.relationOps).toEqual([
                { relation: 'sellerChannel', of: result, op: 'set', value: sellerChannel },
            ]);
        });

        it('throws EntityNotFoundError when the variant is not in the channel', async () => {
            const order = new Order({ id: 5, lines: [] });
            connection.findOneInChannel.mockResolvedValue(undefined);

            await expect(orderModifier.getOrCreateOrderLine(ctx, order, 100)).rejects.toBeInstanceOf(
                EntityNotFoundError,
            );
            expect(connection.findOneInChannel).toHaveBeenCalledWith(
                ctx,
                ProductVariant,
                100,
                ctx.channelId,
                expect.objectContaining({ relations: ['product', 'productVariantPrices', 'taxCategory'] }),
            );
        });
    });

    describe('updateOrderLineQuantity()', () => {
        function lineInOrder(active: boolean, state: string, quantity: number) {
            const order = createOrderFromLines([{ lineId: 1, quantity, productVariantId: 100 }]);
            order.active = active;
            order.state = state as any;
            return { order, line: order.lines[0] };
        }

        it('sets the quantity, saves the line and publishes an updated event', async () => {
            const { order, line } = lineInOrder(true, 'AddingItems', 1);

            const result = await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);

            expect(result).toBe(line);
            expect(line.quantity).toBe(3);
            expect(repos.OrderLine.save).toHaveBeenCalledWith(line);
            const event = eventBus.publish.mock.calls[0][0] as OrderLineEvent;
            expect(event.type).toBe('updated');
            expect(event.orderLine).toBe(line);
        });

        it('does not touch stock for an active order', async () => {
            const { order, line } = lineInOrder(true, 'AddingItems', 1);

            await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);
            await orderModifier.updateOrderLineQuantity(ctx, line, 1, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createReleasesForOrderLines).not.toHaveBeenCalled();
        });

        it('does not touch stock for a Draft order', async () => {
            const { order, line } = lineInOrder(false, 'Draft', 1);

            await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('allocates the additional quantity for a placed order', async () => {
            const { order, line } = lineInOrder(false, 'Modifying', 2);

            await orderModifier.updateOrderLineQuantity(ctx, line, 5, order);

            expect(stockMovementService.createAllocationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 1, quantity: 3 },
            ]);
        });

        it('cancels and releases down to the new quantity for a placed order', async () => {
            const { order, line } = lineInOrder(false, 'Modifying', 5);

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, order);

            expect(stockMovementService.createCancellationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 1, quantity: 2 },
            ]);
            expect(stockMovementService.createReleasesForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 1, quantity: 2 },
            ]);
        });

        it('does not touch stock when the quantity is unchanged', async () => {
            const { order, line } = lineInOrder(false, 'Modifying', 2);

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(repos.OrderLine.save).toHaveBeenCalledWith(line);
        });
    });

    describe('cancelOrderByOrderLines()', () => {
        it('returns EmptyOrderLineSelectionError for no lines', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, []);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
            expect(connection.getRepository).not.toHaveBeenCalled();
        });

        it('returns EmptyOrderLineSelectionError when the total quantity is zero', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 0 },
                { orderLineId: 2, quantity: 0 },
            ]);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
        });

        it('returns MultipleOrderError when the lines span several orders', async () => {
            repos.OrderLine.find.mockResolvedValue([
                new OrderLine({ id: 1, order: new Order({ id: 1, channels: [ctx.channel] }) }),
                new OrderLine({ id: 2, order: new Order({ id: 2, channels: [ctx.channel] }) }),
            ]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
                { orderLineId: 2, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns MultipleOrderError when the lines belong to a different order than requested', async () => {
            repos.OrderLine.find.mockResolvedValue([
                new OrderLine({ id: 1, order: new Order({ id: 2, channels: [ctx.channel] }) }),
            ]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns CancelActiveOrderError for an active order', async () => {
            repos.OrderLine.find.mockResolvedValue([
                new OrderLine({
                    id: 1,
                    order: new Order({ id: 1, active: true, state: 'AddingItems', channels: [ctx.channel] }),
                }),
            ]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(CancelActiveOrderError);
            expect((result as CancelActiveOrderError).orderState).toBe('AddingItems');
            expect(connection.getEntityOrThrow).not.toHaveBeenCalled();
        });
    });

    describe('setShippingMethods()', () => {
        it('returns IneligibleShippingMethodError when a method is not eligible', async () => {
            shippingCalculator.getMethodIfEligible.mockResolvedValue(undefined);
            const order = new Order({ id: 1, lines: [], shippingLines: [] });

            const result = await orderModifier.setShippingMethods(ctx, order, [7]);

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
            expect(shippingCalculator.getMethodIfEligible).toHaveBeenCalledWith(ctx, order, 7);
            expect(repos.ShippingLine.save).not.toHaveBeenCalled();
        });
    });

    describe('modifyOrder()', () => {
        function createModifyingOrder(): Order {
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
            order.id = 1;
            order.state = 'Modifying';
            order.active = false;
            order.customer = new Customer({ id: 3 });
            order.couponCodes = [];
            order.surcharges = [];
            order.shippingLines = [];
            order.subTotalWithTax = 2000;
            order.shippingWithTax = 500;
            order.shippingAddress = { streetLine1: 'Old St', countryCode: 'GB' };
            order.billingAddress = {};
            order.lines[0].productVariantId = 100;
            order.lines[0].listPrice = 1000;
            order.lines[0].listPriceIncludesTax = false;
            return order;
        }

        function input(partial: Partial<ModifyOrderInput>): ModifyOrderInput {
            return { orderId: 1, dryRun: true, ...partial };
        }

        it('returns OrderModificationStateError when the order is not in the Modifying state', async () => {
            const order = createModifyingOrder();
            order.state = 'PaymentSettled';

            const result = await orderModifier.modifyOrder(ctx, input({ surcharges: [] }), order);

            expect(result).toBeInstanceOf(OrderModificationStateError);
        });

        it('returns NoChangesSpecifiedError when the input is empty', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                input({ addItems: [], adjustOrderLines: [], surcharges: [], shippingMethodIds: [] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(NoChangesSpecifiedError);
        });

        it('returns NegativeQuantityError for a negative addItems quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                input({ addItems: [{ productVariantId: 100, quantity: -1 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('returns NegativeQuantityError for a negative adjustOrderLines quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                input({ adjustOrderLines: [{ orderLineId: 1, quantity: -1 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('throws UserInputError when adjusting a line the order does not contain', async () => {
            await expect(
                orderModifier.modifyOrder(
                    ctx,
                    input({ adjustOrderLines: [{ orderLineId: 99, quantity: 1 }] }),
                    createModifyingOrder(),
                ),
            ).rejects.toBeInstanceOf(UserInputError);
        });

        it('increases an existing line quantity and records a modification line', async () => {
            const order = createModifyingOrder();

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ adjustOrderLines: [{ orderLineId: 1, quantity: 5 }] }),
                order,
            );

            expect(result).toHaveProperty('modification');
            const { modification } = result as { order: Order; modification: OrderModification };
            expect(order.lines[0].quantity).toBe(5);
            expect(stockMovementService.createAllocationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 1, quantity: 3 },
            ]);
            expect(modification.lines).toHaveLength(1);
            expect(modification.lines[0]).toBeInstanceOf(OrderModificationLine);
            expect(modification.lines[0].quantity).toBe(3);
            expect(modification.lines[0].orderLine).toBe(order.lines[0]);
            expect(orderCalculator.applyPriceAdjustments).toHaveBeenCalledWith(
                ctx,
                order,
                [],
                [order.lines[0]],
                { recalculateShipping: undefined },
            );
        });

        it('adds a new item via a new order line', async () => {
            const order = createModifyingOrder();
            connection.findOneInChannel.mockResolvedValue(
                new ProductVariant({ id: 200, listPrice: 300, product: new Product({ id: 2 }) }),
            );

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ addItems: [{ productVariantId: 200, quantity: 2 }] }),
                order,
            );

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(order.lines).toHaveLength(2);
            expect(order.lines[1].quantity).toBe(2);
            expect(order.lines[1].listPrice).toBe(300);
            expect(modification.lines[0].quantity).toBe(2);
            expect(modification.lines[0].orderLine).toBe(order.lines[1]);
        });

        it('returns OrderLimitError when adding items would exceed orderItemsLimit', async () => {
            mockConfigService.orderOptions.orderItemsLimit = 3;
            connection.findOneInChannel.mockResolvedValue(
                new ProductVariant({ id: 200, listPrice: 300, product: new Product({ id: 2 }) }),
            );

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ addItems: [{ productVariantId: 200, quantity: 2 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(OrderLimitError);
        });

        it('returns InsufficientStockError when the added quantity is not saleable', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(1);
            connection.findOneInChannel.mockResolvedValue(
                new ProductVariant({ id: 200, listPrice: 300, product: new Product({ id: 2 }) }),
            );

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ addItems: [{ productVariantId: 200, quantity: 2 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(InsufficientStockError);
            expect((result as InsufficientStockError).quantityAvailable).toBe(1);
        });

        it('returns OrderLimitError when adjusting a line would exceed orderItemsLimit', async () => {
            mockConfigService.orderOptions.orderItemsLimit = 4;

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ adjustOrderLines: [{ orderLineId: 1, quantity: 5 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(OrderLimitError);
        });

        it('returns InsufficientStockError when the adjusted quantity is not saleable', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(1);

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ adjustOrderLines: [{ orderLineId: 1, quantity: 5 }] }),
                createModifyingOrder(),
            );

            expect(result).toBeInstanceOf(InsufficientStockError);
        });

        it('adds a surcharge to the order and the modification', async () => {
            const order = createModifyingOrder();

            const result = await orderModifier.modifyOrder(
                ctx,
                input({
                    surcharges: [
                        {
                            description: 'Handling',
                            sku: 'HANDLING',
                            price: 250,
                            priceIncludesTax: false,
                            taxRate: 20,
                            taxDescription: 'VAT',
                        },
                    ],
                }),
                order,
            );

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(order.surcharges).toHaveLength(1);
            const surcharge = order.surcharges[0];
            expect(surcharge).toBeInstanceOf(Surcharge);
            expect(surcharge.description).toBe('Handling');
            expect(surcharge.sku).toBe('HANDLING');
            expect(surcharge.listPrice).toBe(250);
            expect(surcharge.listPriceIncludesTax).toBe(false);
            expect(surcharge.taxLines).toEqual([{ taxRate: 20, description: 'VAT' }]);
            expect(modification.surcharges).toEqual([surcharge]);
            expect(repos.Order.save).toHaveBeenCalledWith(order, { reload: false });
        });

        it('adds no tax lines to a surcharge without a tax rate', async () => {
            const order = createModifyingOrder();

            await orderModifier.modifyOrder(
                ctx,
                input({ surcharges: [{ description: 'Discount', price: -100, priceIncludesTax: true }] }),
                order,
            );

            expect(order.surcharges[0].taxLines).toEqual([]);
            expect(order.surcharges[0].sku).toBe('');
        });

        it('merges the shipping address change and resolves the country name', async () => {
            const order = createModifyingOrder();

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ updateShippingAddress: { streetLine1: 'New St', countryCode: 'DE' } }),
                order,
            );

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(order.shippingAddress).toEqual({
                streetLine1: 'New St',
                countryCode: 'DE',
                country: 'Country DE',
            });
            expect(countryService.findOneByCode).toHaveBeenCalledWith(ctx, 'DE');
            expect(modification.shippingAddressChange).toEqual({ streetLine1: 'New St', countryCode: 'DE' });
        });

        it('merges the billing address change without a country lookup when no code is given', async () => {
            const order = createModifyingOrder();

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ updateBillingAddress: { city: 'Berlin' } }),
                order,
            );

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(order.billingAddress).toEqual({ city: 'Berlin' });
            expect(countryService.findOneByCode).not.toHaveBeenCalled();
            expect(modification.billingAddressChange).toEqual({ city: 'Berlin' });
        });

        it('returns the coupon validation error result', async () => {
            const order = createModifyingOrder();
            const error = new CouponCodeInvalidError({ couponCode: 'BAD' });
            promotionService.validateCouponCode.mockResolvedValue(error);

            const result = await orderModifier.modifyOrder(ctx, input({ couponCodes: ['BAD'] }), order);

            expect(result).toBe(error);
            expect(promotionService.validateCouponCode).toHaveBeenCalledWith(ctx, 'BAD', 3);
        });

        it('records applied and removed coupon codes in the history', async () => {
            const order = createModifyingOrder();
            order.couponCodes = ['OLD'];
            promotionService.validateCouponCode.mockResolvedValue({ id: 'promo-1', couponCode: 'NEW' });

            await orderModifier.modifyOrder(ctx, input({ couponCodes: ['new'] }), order);

            expect(order.couponCodes).toEqual(['NEW']);
            expect(historyService.createHistoryEntryForOrder).toHaveBeenCalledWith({
                ctx,
                orderId: 1,
                type: HistoryEntryType.ORDER_COUPON_APPLIED,
                data: { couponCode: 'NEW', promotionId: 'promo-1' },
            });
            expect(historyService.createHistoryEntryForOrder).toHaveBeenCalledWith({
                ctx,
                orderId: 1,
                type: HistoryEntryType.ORDER_COUPON_REMOVED,
                data: { couponCode: 'OLD' },
            });
        });

        it('does not record history for a coupon code that was already applied', async () => {
            const order = createModifyingOrder();
            order.couponCodes = ['SAVE'];
            promotionService.validateCouponCode.mockResolvedValue({ id: 'promo-1', couponCode: 'SAVE' });

            await orderModifier.modifyOrder(ctx, input({ couponCodes: ['SAVE', 'save'] }), order);

            expect(order.couponCodes).toEqual(['SAVE']);
            expect(historyService.createHistoryEntryForOrder).not.toHaveBeenCalled();
        });

        it('returns the shipping method error result', async () => {
            const order = createModifyingOrder();
            shippingCalculator.getMethodIfEligible.mockResolvedValue(undefined);

            const result = await orderModifier.modifyOrder(ctx, input({ shippingMethodIds: [7] }), order);

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
        });

        it('recalculates the unit price of updated lines using the price calculation strategy', async () => {
            const order = createModifyingOrder();
            const strategy = mockConfigService.orderOptions.orderItemPriceCalculationStrategy;
            strategy.calculateUnitPrice.mockResolvedValue({ price: 750, priceIncludesTax: true });

            await orderModifier.modifyOrder(
                ctx,
                input({ adjustOrderLines: [{ orderLineId: 1, quantity: 3 }] }),
                order,
            );

            expect(productVariantService.applyChannelPriceAndTax).toHaveBeenCalledWith(
                order.lines[0].productVariant,
                ctx,
                order,
            );
            expect(strategy.calculateUnitPrice).toHaveBeenCalledWith(
                ctx,
                order.lines[0].productVariant,
                {},
                order,
                3,
            );
            expect(order.lines[0].listPrice).toBe(750);
            expect(order.lines[0].listPriceIncludesTax).toBe(true);
        });

        it('patches order custom fields', async () => {
            const order = createModifyingOrder();
            order.customFields = { existing: 'a', note: null } as any;

            await orderModifier.modifyOrder(
                ctx,
                { ...input({}), customFields: { note: 'hi' } } as ModifyOrderInput,
                order,
            );

            expect(order.customFields).toEqual({ existing: 'a', note: 'hi' });
        });

        it('returns the unsaved modification on a dry run', async () => {
            const order = createModifyingOrder();

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ dryRun: true, updateBillingAddress: { city: 'Berlin' } }),
                order,
            );

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(modification.id).toBeUndefined();
            expect(repos.OrderModification.save).not.toHaveBeenCalled();
            expect(eventBus.publish).not.toHaveBeenCalled();
        });

        it('persists the modification with the price change and publishes an OrderEvent', async () => {
            const order = createModifyingOrder();
            orderCalculator.applyPriceAdjustments.mockImplementation(
                async (_ctx: RequestContext, o: Order) => {
                    o.subTotalWithTax = 2600;
                    return o;
                },
            );
            const modifyInput = input({
                dryRun: false,
                note: 'more',
                updateBillingAddress: { city: 'Berlin' },
            });

            const result = await orderModifier.modifyOrder(ctx, modifyInput, order);

            const { modification } = result as { order: Order; modification: OrderModification };
            expect(modification.priceChange).toBe(600);
            expect(modification.note).toBe('more');
            expect(modification.order).toBe(order);
            expect(repos.OrderModification.saved).toEqual([modification]);
            expect(repos.Order.save).toHaveBeenCalledWith(order);
            expect(repos.ShippingLine.save).toHaveBeenCalledWith(order.shippingLines, { reload: false });
            const event = eventBus.publish.mock.calls[0][0] as OrderEvent;
            expect(event).toBeInstanceOf(OrderEvent);
            expect(event.type).toBe('updated');
            expect(event.input).toBe(modifyInput);
        });

        const discount = {
            description: 'Goodwill discount',
            sku: 'DISC',
            price: -1000,
            priceIncludesTax: true,
            taxRate: 0,
        };

        it('returns RefundPaymentIdMissingError when the total drops and no refund is given', async () => {
            const order = createModifyingOrder();
            setupPriceDrop(order, 1000);

            const result = await orderModifier.modifyOrder(
                ctx,
                input({ dryRun: false, surcharges: [discount] }),
                order,
            );

            expect(result).toBeInstanceOf(RefundPaymentIdMissingError);
            expect(repos.OrderModification.save).not.toHaveBeenCalled();
        });

        function setupPriceDrop(order: Order, newSubTotalWithTax: number, newShippingWithTax?: number) {
            orderCalculator.applyPriceAdjustments.mockImplementation(
                async (_ctx: RequestContext, o: Order) => {
                    o.subTotalWithTax = newSubTotalWithTax;
                    if (newShippingWithTax != null) {
                        o.shippingWithTax = newShippingWithTax;
                    }
                    return o;
                },
            );
        }

        describe('refunds', () => {
            it('creates a refund against the given payment and attaches it to the modification', async () => {
                const order = createModifyingOrder();
                setupPriceDrop(order, 1000);
                const payment = new Payment({ id: 'pay-1', state: 'Settled', amount: 2500 });
                repos.Payment.find.mockResolvedValue([payment]);
                const refund = new Refund({ id: 'refund-1' });
                paymentService.createRefund.mockResolvedValue(refund);

                const result = await orderModifier.modifyOrder(
                    ctx,
                    input({
                        dryRun: false,
                        surcharges: [discount],
                        refund: { paymentId: 'pay-1', amount: 1000, reason: 'less' },
                    }),
                    order,
                );

                const { modification } = result as { order: Order; modification: OrderModification };
                expect(modification.priceChange).toBe(-1000);
                expect(modification.refund).toBe(refund);
                expect(repos.Payment.find).toHaveBeenCalledWith({
                    relations: ['refunds'],
                    where: { order: { id: 1 } },
                });
                expect(paymentService.createRefund).toHaveBeenCalledWith(
                    ctx,
                    {
                        lines: [],
                        adjustment: 1000,
                        shipping: 0,
                        paymentId: 'pay-1',
                        amount: 1000,
                        reason: 'less',
                    },
                    order,
                    payment,
                );
            });

            it('supports the refunds array and picks the largest as the primary refund', async () => {
                const order = createModifyingOrder();
                setupPriceDrop(order, 1000);
                const small = new Payment({ id: 'pay-small', state: 'Settled', amount: 500 });
                const large = new Payment({ id: 'pay-large', state: 'Settled', amount: 2000 });
                repos.Payment.find.mockResolvedValue([small, large]);
                const smallRefund = new Refund({ id: 'refund-small' });
                const largeRefund = new Refund({ id: 'refund-large' });
                paymentService.createRefund.mockImplementation(
                    async (_ctx: RequestContext, _input: any, _order: Order, payment: Payment) =>
                        payment === large ? largeRefund : smallRefund,
                );

                const result = await orderModifier.modifyOrder(
                    ctx,
                    input({
                        dryRun: false,
                        surcharges: [discount],
                        refunds: [
                            { paymentId: 'pay-small', amount: 300 },
                            { paymentId: 'pay-large', amount: 700 },
                        ],
                    }),
                    order,
                );

                const { modification } = result as { order: Order; modification: OrderModification };
                expect(paymentService.createRefund).toHaveBeenCalledTimes(2);
                expect(modification.refund).toBe(largeRefund);
            });

            it('skips refunds whose payment does not belong to the order', async () => {
                const order = createModifyingOrder();
                setupPriceDrop(order, 1000);
                repos.Payment.find.mockResolvedValue([]);

                const result = await orderModifier.modifyOrder(
                    ctx,
                    input({
                        dryRun: false,
                        surcharges: [discount],
                        refund: { paymentId: 'unknown', amount: 1000 },
                    }),
                    order,
                );

                const { modification } = result as { order: Order; modification: OrderModification };
                expect(paymentService.createRefund).not.toHaveBeenCalled();
                expect(modification.refund).toBeUndefined();
                expect(modification.priceChange).toBe(-1000);
            });

            it('throws InternalServerError when the refund fails', async () => {
                const order = createModifyingOrder();
                setupPriceDrop(order, 1000);
                repos.Payment.find.mockResolvedValue([
                    new Payment({ id: 'pay-1', state: 'Settled', amount: 2500 }),
                ]);
                paymentService.createRefund.mockResolvedValue(
                    new RefundStateTransitionError({
                        transitionError: 'nope',
                        fromState: 'Pending',
                        toState: 'Settled',
                    }),
                );

                await expect(
                    orderModifier.modifyOrder(
                        ctx,
                        input({
                            dryRun: false,
                            surcharges: [discount],
                            refund: { paymentId: 'pay-1', amount: 1000 },
                        }),
                        order,
                    ),
                ).rejects.toBeInstanceOf(InternalServerError);
            });

            it('splits the refund into a shipping delta and an adjustment for the remainder', async () => {
                const order = createModifyingOrder();
                // subTotal drops 2000 -> 1000, shipping drops 500 -> 300
                setupPriceDrop(order, 1000, 300);
                repos.Payment.find.mockResolvedValue([
                    new Payment({ id: 'pay-1', state: 'Settled', amount: 2500 }),
                ]);
                paymentService.createRefund.mockResolvedValue(new Refund({ id: 'refund-1' }));

                await orderModifier.modifyOrder(
                    ctx,
                    input({
                        dryRun: false,
                        surcharges: [discount],
                        refund: { paymentId: 'pay-1', amount: 1200 },
                    }),
                    order,
                );

                const refundInput = paymentService.createRefund.mock.calls[0][1];
                expect(refundInput.shipping).toBe(200);
                // |delta| = 1200; shipping explains 200, so the remaining 1000 is an adjustment
                expect(refundInput.adjustment).toBe(1000);
            });
        });
    });
});
