// Imported first so that the circular import chain through the services resolves with
// OrderModifier's constructor parameter types intact (otherwise CountryService is undefined).
import { OrderModifier } from './order-modifier';

import { Test } from '@nestjs/testing';
import { ModifyOrderInput } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { EntityNotFoundError, UserInputError } from '../../../common/error/errors';
import {
    CancelActiveOrderError,
    EmptyOrderLineSelectionError,
    MultipleOrderError,
    NoChangesSpecifiedError,
    OrderModificationStateError,
    QuantityTooGreatError,
} from '../../../common/error/generated-graphql-admin-errors';
import {
    IneligibleShippingMethodError,
    NegativeQuantityError,
} from '../../../common/error/generated-graphql-shop-errors';
import { ensureConfigLoaded } from '../../../config/config-helpers';
import { ConfigService } from '../../../config/config.service';
import { MockConfigService } from '../../../config/config.service.mock';
import { CustomFieldConfig } from '../../../config/custom-field/custom-field-types';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { Order } from '../../../entity/order/order.entity';
import { ProductVariant } from '../../../entity/product-variant/product-variant.entity';
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

const CHANNEL_ID = 1;

describe('OrderModifier', () => {
    let orderModifier: OrderModifier;
    let configService: MockConfigService;
    let rows: Map<any, any[]>;
    let save: ReturnType<typeof vi.fn>;
    let find: ReturnType<typeof vi.fn>;
    let getEntityOrThrow: ReturnType<typeof vi.fn>;
    let productVariantService: { getSaleableStockLevel: ReturnType<typeof vi.fn> };
    let stockMovementService: {
        createAllocationsForOrderLines: ReturnType<typeof vi.fn>;
        createCancellationsForOrderLines: ReturnType<typeof vi.fn>;
        createReleasesForOrderLines: ReturnType<typeof vi.fn>;
    };
    let shippingCalculator: { getMethodIfEligible: ReturnType<typeof vi.fn> };
    let eventBus: { publish: ReturnType<typeof vi.fn> };
    const ctx = new RequestContext({
        apiType: 'admin',
        channel: new Channel({ id: CHANNEL_ID }),
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
    });

    beforeEach(async () => {
        await ensureConfigLoaded();
        rows = new Map();
        save = vi.fn().mockImplementation((entity: any) => Promise.resolve(entity));
        find = vi.fn();
        getEntityOrThrow = vi.fn();
        const connection = {
            getRepository: (_ctx: RequestContext, entity: any) => ({
                save,
                find: (...args: any[]) => {
                    find(entity, ...args);
                    return Promise.resolve(rows.get(entity) ?? []);
                },
            }),
            getEntityOrThrow,
        } as unknown as TransactionalConnection;
        productVariantService = { getSaleableStockLevel: vi.fn().mockResolvedValue(100) };
        stockMovementService = {
            createAllocationsForOrderLines: vi.fn().mockResolvedValue([]),
            createCancellationsForOrderLines: vi.fn().mockResolvedValue([]),
            createReleasesForOrderLines: vi.fn().mockResolvedValue([]),
        };
        shippingCalculator = { getMethodIfEligible: vi.fn() };
        eventBus = { publish: vi.fn().mockResolvedValue(undefined) };

        const module = await Test.createTestingModule({
            providers: [
                OrderModifier,
                { provide: ConfigService, useClass: MockConfigService },
                { provide: TransactionalConnection, useValue: connection },
                { provide: OrderCalculator, useValue: {} },
                { provide: PaymentService, useValue: {} },
                { provide: CountryService, useValue: {} },
                { provide: StockMovementService, useValue: stockMovementService },
                { provide: ProductVariantService, useValue: productVariantService },
                { provide: CustomFieldRelationService, useValue: {} },
                { provide: PromotionService, useValue: {} },
                { provide: EventBus, useValue: eventBus },
                { provide: ShippingCalculator, useValue: shippingCalculator },
                { provide: HistoryService, useValue: {} },
                { provide: TranslatorService, useValue: {} },
            ],
        }).compile();
        configService = module.get<ConfigService, MockConfigService>(ConfigService);
        configService.customFields = { OrderLine: [] };
        orderModifier = module.get(OrderModifier);
    });

    describe('constrainQuantityToSaleable()', () => {
        const variant = new ProductVariant({ id: 100 });

        it('returns the requested quantity when stock is sufficient', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 4)).toBe(4);
            expect(productVariantService.getSaleableStockLevel).toHaveBeenCalledWith(ctx, variant);
        });

        it('caps the quantity at the saleable stock level', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(3);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 5)).toBe(3);
        });

        it('adds the existing line quantity to the requested quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 2)).toBe(6);
        });

        it('caps the combined quantity, returning the stock available beyond the existing line', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(5);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 2)).toBe(3);
        });

        it('accounts for the same variant in other order lines', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(5);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 0, 3)).toBe(2);
        });

        it('never returns a negative quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(1);

            expect(await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 2, 3)).toBe(0);
        });
    });

    describe('getExistingOrderLine()', () => {
        function lineWithCustomFields(id: number, productVariantId: number, customFields?: any): OrderLine {
            return new OrderLine({ id, productVariantId, customFields });
        }

        it('returns the line with a matching productVariantId when no custom fields are defined', async () => {
            const order = new Order({
                lines: [lineWithCustomFields(1, 100), lineWithCustomFields(2, 200)],
            });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 200);

            expect(result).toBe(order.lines[1]);
        });

        it('returns undefined when no line has the productVariantId', async () => {
            const order = new Order({ lines: [lineWithCustomFields(1, 100)] });

            expect(await orderModifier.getExistingOrderLine(ctx, order, 999)).toBeUndefined();
        });

        it('matches on string vs number ids', async () => {
            const order = new Order({ lines: [lineWithCustomFields(1, 100)] });

            expect(await orderModifier.getExistingOrderLine(ctx, order, '100')).toBe(order.lines[0]);
        });

        describe('with custom fields', () => {
            const giftWrap: CustomFieldConfig = { name: 'giftWrap', type: 'boolean' };
            const note: CustomFieldConfig = { name: 'note', type: 'string', defaultValue: '' };
            const tags: CustomFieldConfig = { name: 'tags', type: 'string', list: true };

            beforeEach(() => {
                configService.customFields = { OrderLine: [giftWrap, note, tags] };
            });

            it('matches when the custom field values are equal', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: true, note: 'hi', tags: ['a'] })],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    giftWrap: true,
                    note: 'hi',
                    tags: ['a'],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('does not match when a custom field value differs', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: true, note: 'hi', tags: [] })],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    giftWrap: false,
                    note: 'hi',
                    tags: [],
                });

                expect(result).toBeUndefined();
            });

            it('treats a numeric boolean (MySQL) as equal to its boolean input', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: 0, note: null, tags: [] })],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    giftWrap: false,
                    tags: [],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('treats an omitted input field as matching a null existing value', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: null, note: null, tags: null })],
                });

                expect(await orderModifier.getExistingOrderLine(ctx, order, 100, {})).toBe(order.lines[0]);
            });

            it('treats an omitted input field as matching the default value', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: null, note: '', tags: null })],
                });

                expect(await orderModifier.getExistingOrderLine(ctx, order, 100, {})).toBe(order.lines[0]);
            });

            it('treats undefined input as matching a line whose fields are all null, empty or default', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: null, note: '', tags: [] })],
                });

                expect(await orderModifier.getExistingOrderLine(ctx, order, 100)).toBe(order.lines[0]);
            });

            it('treats undefined input as not matching a line with a non-default value', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: null, note: 'custom', tags: [] })],
                });

                expect(await orderModifier.getExistingOrderLine(ctx, order, 100)).toBeUndefined();
            });

            it('treats undefined input as not matching a line with a set field without a default', async () => {
                const order = new Order({
                    lines: [lineWithCustomFields(1, 100, { giftWrap: true, note: '', tags: [] })],
                });

                expect(await orderModifier.getExistingOrderLine(ctx, order, 100)).toBeUndefined();
            });
        });
    });

    describe('getOrCreateOrderLine()', () => {
        it('returns the existing line without touching the database', async () => {
            const order = new Order({ lines: [new OrderLine({ id: 1, productVariantId: 100 })] });

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100);

            expect(result).toBe(order.lines[0]);
            expect(save).not.toHaveBeenCalled();
            expect(order.lines).toHaveLength(1);
        });
    });

    describe('updateOrderLineQuantity()', () => {
        function setup(quantity: number, order: Partial<Order>) {
            const orderLine = new OrderLine({ id: 7, quantity });
            return { orderLine, order: new Order({ lines: [orderLine], ...order }) };
        }

        it('sets the quantity, saves the line and publishes an "updated" OrderLineEvent', async () => {
            const { orderLine, order } = setup(1, { active: true });

            const result = await orderModifier.updateOrderLineQuantity(ctx, orderLine, 3, order);

            expect(result).toBe(orderLine);
            expect(orderLine.quantity).toBe(3);
            expect(save).toHaveBeenCalledWith(orderLine);
            const event = eventBus.publish.mock.calls[0][0];
            expect(event).toBeInstanceOf(OrderLineEvent);
            expect(event.type).toBe('updated');
            expect(event.orderLine).toBe(orderLine);
            expect(event.order).toBe(order);
        });

        it('does not touch stock for an active order', async () => {
            const { orderLine, order } = setup(1, { active: true });

            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 3, order);
            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 1, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createReleasesForOrderLines).not.toHaveBeenCalled();
        });

        it('does not touch stock for a Draft order', async () => {
            const { orderLine, order } = setup(1, { active: false, state: 'Draft' });

            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 3, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('allocates only the additional quantity when a placed order line is increased', async () => {
            const { orderLine, order } = setup(2, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 5, order);

            expect(stockMovementService.createAllocationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 7, quantity: 3 },
            ]);
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
        });

        it('cancels and releases down to the new quantity when a placed order line is decreased', async () => {
            const { orderLine, order } = setup(5, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 2, order);

            expect(stockMovementService.createCancellationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 7, quantity: 2 },
            ]);
            expect(stockMovementService.createReleasesForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 7, quantity: 2 },
            ]);
            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('makes no stock movements when the quantity is unchanged', async () => {
            const { orderLine, order } = setup(2, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, orderLine, 2, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(save).toHaveBeenCalledWith(orderLine);
        });
    });

    describe('cancelOrderByOrderLines()', () => {
        function placedOrder(id: number, active = false): Order {
            return new Order({
                id,
                active,
                state: 'PaymentSettled',
                channels: [new Channel({ id: CHANNEL_ID })],
            });
        }

        it('returns EmptyOrderLineSelectionError when no lines are given', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, []);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
            expect(find).not.toHaveBeenCalled();
        });

        it('returns EmptyOrderLineSelectionError when all quantities are zero', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 0 },
            ]);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
        });

        it('returns MultipleOrderError when the lines belong to different orders', async () => {
            rows.set(OrderLine, [
                new OrderLine({ id: 1, order: placedOrder(1) }),
                new OrderLine({ id: 2, order: placedOrder(2) }),
            ]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
                { orderLineId: 2, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns MultipleOrderError when the lines belong to a different order than the input', async () => {
            rows.set(OrderLine, [new OrderLine({ id: 1, order: placedOrder(2) })]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('throws EntityNotFoundError for a line whose order is not in the active channel', async () => {
            const order = placedOrder(1);
            order.channels = [new Channel({ id: 99 })];
            rows.set(OrderLine, [new OrderLine({ id: 1, order })]);

            await expect(
                orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [{ orderLineId: 1, quantity: 1 }]),
            ).rejects.toBeInstanceOf(EntityNotFoundError);
        });

        it('returns CancelActiveOrderError for an active order', async () => {
            const order = placedOrder(1, true);
            order.state = 'AddingItems';
            rows.set(OrderLine, [new OrderLine({ id: 1, order })]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(CancelActiveOrderError);
            expect((result as CancelActiveOrderError).orderState).toBe('AddingItems');
        });

        it('returns QuantityTooGreatError when cancelling more than the line quantity', async () => {
            rows.set(OrderLine, [new OrderLine({ id: 1, order: placedOrder(1) })]);
            getEntityOrThrow.mockResolvedValue(
                new Order({ id: 1, lines: [new OrderLine({ id: 1, quantity: 2 })] }),
            );

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 1, quantity: 3 },
            ]);

            expect(result).toBeInstanceOf(QuantityTooGreatError);
            expect(getEntityOrThrow).toHaveBeenCalledWith(ctx, Order, 1, { relations: ['lines'] });
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
        });
    });

    describe('modifyOrder()', () => {
        function modifyingOrder(): Order {
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
            order.id = 1;
            order.state = 'Modifying';
            order.subTotalWithTax = 0;
            order.shippingWithTax = 0;
            return order;
        }

        it('returns OrderModificationStateError when the order is not in the Modifying state', async () => {
            const order = modifyingOrder();
            order.state = 'PaymentSettled';

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, addItems: [{ productVariantId: 100, quantity: 1 }] },
                order,
            );

            expect(result).toBeInstanceOf(OrderModificationStateError);
        });

        it('returns NoChangesSpecifiedError for an input with no changes', async () => {
            const inputs: ModifyOrderInput[] = [
                { orderId: 1, dryRun: false },
                { orderId: 1, dryRun: false, addItems: [], adjustOrderLines: [], surcharges: [] },
                { orderId: 1, dryRun: false, shippingMethodIds: [] },
            ];
            for (const input of inputs) {
                const result = await orderModifier.modifyOrder(ctx, input, modifyingOrder());
                expect(result).toBeInstanceOf(NoChangesSpecifiedError);
            }
        });

        it('returns NegativeQuantityError when adding a negative quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, addItems: [{ productVariantId: 100, quantity: -1 }] },
                modifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
            expect(save).not.toHaveBeenCalled();
        });

        it('returns NegativeQuantityError when adjusting a line to a negative quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, adjustOrderLines: [{ orderLineId: 1, quantity: -1 }] },
                modifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('throws UserInputError when adjusting a line the order does not contain', async () => {
            let error: any;
            try {
                await orderModifier.modifyOrder(
                    ctx,
                    { orderId: 1, dryRun: false, adjustOrderLines: [{ orderLineId: 999, quantity: 1 }] },
                    modifyingOrder(),
                );
            } catch (e) {
                error = e;
            }

            expect(error).toBeInstanceOf(UserInputError);
            expect(error.variables).toEqual({ id: 999 });
        });
    });

    describe('setShippingMethods()', () => {
        it('returns IneligibleShippingMethodError when a method is not eligible', async () => {
            shippingCalculator.getMethodIfEligible.mockResolvedValue(undefined);
            const order = new Order({ id: 1, lines: [], shippingLines: [] });

            const result = await orderModifier.setShippingMethods(ctx, order, [5]);

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
            expect(shippingCalculator.getMethodIfEligible).toHaveBeenCalledWith(ctx, order, 5);
            expect(save).not.toHaveBeenCalled();
        });
    });

    describe('calculateRefundAdjustment()', () => {
        it('returns zero when the refund already accounts for the whole delta', async () => {
            getEntityOrThrow.mockResolvedValue(
                new OrderLine({
                    id: 1,
                    listPrice: 1000,
                    listPriceIncludesTax: true,
                    quantity: 2,
                    adjustments: [],
                    taxLines: [],
                }),
            );

            const result = await (orderModifier as any).calculateRefundAdjustment(ctx, -2500, {
                lines: [{ orderLineId: 1, quantity: 2 }],
                shipping: 500,
                adjustment: 0,
                paymentId: 1,
            });

            expect(result).toBe(0);
            expect(getEntityOrThrow).toHaveBeenCalledWith(ctx, OrderLine, 1);
        });

        it('returns the shortfall between the delta and the refund lines, shipping and adjustment', async () => {
            getEntityOrThrow.mockResolvedValue(
                new OrderLine({
                    id: 1,
                    listPrice: 1000,
                    listPriceIncludesTax: true,
                    quantity: 2,
                    adjustments: [],
                    taxLines: [],
                }),
            );

            const result = await (orderModifier as any).calculateRefundAdjustment(ctx, -3000, {
                lines: [{ orderLineId: 1, quantity: 1 }],
                shipping: 500,
                adjustment: 100,
                paymentId: 1,
            });

            expect(result).toBe(1400);
        });

        it('returns a negative correction when the refund exceeds the delta', async () => {
            const result = await (orderModifier as any).calculateRefundAdjustment(ctx, -100, {
                lines: [],
                shipping: 300,
                adjustment: 0,
                paymentId: 1,
            });

            expect(result).toBe(-200);
            expect(getEntityOrThrow).not.toHaveBeenCalled();
        });
    });
});
