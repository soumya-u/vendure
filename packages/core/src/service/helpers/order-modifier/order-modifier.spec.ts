import { Test } from '@nestjs/testing';
import { LanguageCode, ModifyOrderInput } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { UserInputError } from '../../../common/error/errors';
import {
    CancelActiveOrderError,
    EmptyOrderLineSelectionError,
    MultipleOrderError,
    NoChangesSpecifiedError,
    OrderModificationStateError,
} from '../../../common/error/generated-graphql-admin-errors';
import {
    IneligibleShippingMethodError,
    NegativeQuantityError,
} from '../../../common/error/generated-graphql-shop-errors';
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

import { OrderModifier } from './order-modifier';

describe('OrderModifier', () => {
    let orderModifier: OrderModifier;
    let configService: MockConfigService;
    let orderLineRepo: { save: ReturnType<typeof vi.fn>; find: ReturnType<typeof vi.fn> };
    let connection: { getRepository: ReturnType<typeof vi.fn>; getEntityOrThrow: ReturnType<typeof vi.fn> };
    let productVariantService: { getSaleableStockLevel: ReturnType<typeof vi.fn> };
    let stockMovementService: {
        createAllocationsForOrderLines: ReturnType<typeof vi.fn>;
        createCancellationsForOrderLines: ReturnType<typeof vi.fn>;
        createReleasesForOrderLines: ReturnType<typeof vi.fn>;
    };
    let shippingCalculator: { getMethodIfEligible: ReturnType<typeof vi.fn> };
    let eventBus: { publish: ReturnType<typeof vi.fn> };
    const channel = new Channel({ id: 1, code: '__default_channel__' });
    const ctx = new RequestContext({
        channel,
        apiType: 'admin',
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        languageCode: LanguageCode.en,
    });

    beforeEach(async () => {
        orderLineRepo = {
            save: vi.fn(async (line: OrderLine) => line),
            find: vi.fn().mockResolvedValue([]),
        };
        connection = {
            getRepository: vi.fn((_ctx: RequestContext, entity: any) => {
                if (entity === OrderLine) {
                    return orderLineRepo;
                }
                throw new Error(`Unexpected repository requested: ${String(entity?.name)}`);
            }),
            getEntityOrThrow: vi.fn(),
        };
        productVariantService = { getSaleableStockLevel: vi.fn().mockResolvedValue(10) };
        stockMovementService = {
            createAllocationsForOrderLines: vi.fn().mockResolvedValue([]),
            createCancellationsForOrderLines: vi.fn().mockResolvedValue([]),
            createReleasesForOrderLines: vi.fn().mockResolvedValue([]),
        };
        shippingCalculator = { getMethodIfEligible: vi.fn().mockResolvedValue(undefined) };
        eventBus = { publish: vi.fn().mockResolvedValue(undefined) };

        // OrderModifier cannot be resolved through Nest DI in isolation: the CountryService
        // constructor parameter's metadata is `undefined` at runtime because of an import
        // cycle (country.service -> ... -> order-modifier), so the class is constructed directly
        // with the module-provided ConfigService and the mocked collaborators.
        const module = await Test.createTestingModule({
            providers: [{ provide: ConfigService, useClass: MockConfigService }],
        }).compile();
        configService = module.get<ConfigService, MockConfigService>(ConfigService);
        configService.customFields = { OrderLine: [] };
        configService.orderOptions = { orderItemsLimit: 999 };
        orderModifier = new OrderModifier(
            connection as unknown as TransactionalConnection,
            configService as unknown as ConfigService,
            {} as OrderCalculator,
            {} as PaymentService,
            {} as CountryService,
            stockMovementService as unknown as StockMovementService,
            productVariantService as unknown as ProductVariantService,
            {} as CustomFieldRelationService,
            {} as PromotionService,
            eventBus as unknown as EventBus,
            shippingCalculator as unknown as ShippingCalculator,
            {} as HistoryService,
            {} as TranslatorService,
        );
    });

    function setOrderLineCustomFields(
        defs: Array<Partial<CustomFieldConfig> & { name: string; type: string }>,
    ) {
        configService.customFields = { OrderLine: defs as CustomFieldConfig[] };
    }

    describe('constrainQuantityToSaleable()', () => {
        const variant = new ProductVariant({ id: 1 });

        it('returns the requested quantity when stock is sufficient', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 4);

            expect(result).toBe(4);
            expect(productVariantService.getSaleableStockLevel).toHaveBeenCalledWith(ctx, variant);
        });

        it('adds the existing line quantity to the requested quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(10);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 3);

            expect(result).toBe(7);
        });

        it('caps the result at the saleable stock level', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(5);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 10);

            expect(result).toBe(5);
        });

        it('accounts for existing quantity when capping', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(5);

            // 3 already in the line, wants 10 more, only 5 saleable in total -> 2 more can be added
            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 10, 3);

            expect(result).toBe(2);
        });

        it('accounts for quantity in other lines of the same variant when capping', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(5);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 4, 0, 3);

            expect(result).toBe(2);
        });

        it('never returns a negative quantity', async () => {
            productVariantService.getSaleableStockLevel.mockResolvedValue(2);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, variant, 1, 5, 5);

            expect(result).toBe(0);
        });
    });

    describe('getExistingOrderLine()', () => {
        it('returns undefined when no line has the ProductVariant', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
            order.lines[0].productVariantId = 100;

            const result = await orderModifier.getExistingOrderLine(ctx, order, 200);

            expect(result).toBeUndefined();
        });

        it('returns the line with the matching ProductVariant when there are no custom fields', async () => {
            const order = createOrderFromLines([
                { lineId: 1, quantity: 1, productVariantId: 100 },
                { lineId: 2, quantity: 1, productVariantId: 200 },
            ]);
            order.lines.forEach(l => (l.productVariantId = l.productVariant.id));

            const result = await orderModifier.getExistingOrderLine(ctx, order, 200);

            expect(result).toBe(order.lines[1]);
        });

        it('matches ids of differing types (string vs number)', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
            order.lines[0].productVariantId = 100;

            const result = await orderModifier.getExistingOrderLine(ctx, order, '100');

            expect(result).toBe(order.lines[0]);
        });

        describe('with custom fields', () => {
            beforeEach(() => {
                setOrderLineCustomFields([
                    { name: 'engraving', type: 'string' },
                    { name: 'giftWrap', type: 'boolean', defaultValue: false },
                    { name: 'tags', type: 'string', list: true },
                ]);
            });

            function orderWithLineCustomFields(customFields: Record<string, any>): Order {
                const order = createOrderFromLines([
                    { lineId: 1, quantity: 1, productVariantId: 100, customFields },
                ]);
                order.lines[0].productVariantId = 100;
                return order;
            }

            it('matches when all custom field values are equal', async () => {
                const order = orderWithLineCustomFields({
                    engraving: 'hi',
                    giftWrap: true,
                    tags: ['a', 'b'],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engraving: 'hi',
                    giftWrap: true,
                    tags: ['a', 'b'],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('does not match when a custom field value differs', async () => {
                const order = orderWithLineCustomFields({ engraving: 'hi', giftWrap: false, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engraving: 'bye',
                    giftWrap: false,
                    tags: [],
                });

                expect(result).toBeUndefined();
            });

            it('treats an omitted input value as matching a null existing value', async () => {
                const order = orderWithLineCustomFields({ engraving: null, giftWrap: false, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    giftWrap: false,
                    tags: [],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('treats an omitted input value as matching the defaultValue', async () => {
                const order = orderWithLineCustomFields({ engraving: 'x', giftWrap: false, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engraving: 'x',
                    tags: [],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('coerces a numeric boolean (MySQL) before comparing', async () => {
                const order = orderWithLineCustomFields({ engraving: 'x', giftWrap: 1 as any, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, {
                    engraving: 'x',
                    giftWrap: true,
                    tags: [],
                });

                expect(result).toBe(order.lines[0]);
            });

            it('with null input, matches a line whose custom fields are all null/default/empty', async () => {
                const order = orderWithLineCustomFields({ engraving: null, giftWrap: false, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBe(order.lines[0]);
            });

            it('with null input, does not match a line with a non-default value', async () => {
                const order = orderWithLineCustomFields({ engraving: null, giftWrap: true, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBeUndefined();
            });

            it('with null input, does not match a line with a non-null value and no default', async () => {
                const order = orderWithLineCustomFields({ engraving: 'set', giftWrap: false, tags: [] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBeUndefined();
            });

            it('with null input, does not match a line with a non-empty list value', async () => {
                const order = orderWithLineCustomFields({ engraving: null, giftWrap: false, tags: ['x'] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBeUndefined();
            });

            it('with null input and no existing custom fields object, falls through to the value comparison', async () => {
                const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
                order.lines[0].productVariantId = 100;
                order.lines[0].customFields = undefined as any;

                const result = await orderModifier.getExistingOrderLine(ctx, order, 100, undefined);

                expect(result).toBe(order.lines[0]);
            });
        });
    });

    describe('getOrCreateOrderLine()', () => {
        it('returns the existing OrderLine without touching the database', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);
            order.lines[0].productVariantId = 100;

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 100);

            expect(result).toBe(order.lines[0]);
            expect(order.lines).toHaveLength(1);
            expect(connection.getRepository).not.toHaveBeenCalled();
            expect(eventBus.publish).not.toHaveBeenCalled();
        });
    });

    describe('updateOrderLineQuantity()', () => {
        function lineInOrder(
            quantity: number,
            orderProps: Partial<Order>,
        ): { order: Order; line: OrderLine } {
            const order = createOrderFromLines([{ lineId: 5, quantity, productVariantId: 1 }]);
            Object.assign(order, orderProps);
            return { order, line: order.lines[0] };
        }

        it('sets the new quantity, saves the line and publishes an "updated" OrderLineEvent', async () => {
            const { order, line } = lineInOrder(1, { active: true });

            const result = await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);

            expect(result).toBe(line);
            expect(line.quantity).toBe(3);
            expect(orderLineRepo.save).toHaveBeenCalledWith(line);
            expect(eventBus.publish).toHaveBeenCalledTimes(1);
            const event = eventBus.publish.mock.calls[0][0] as OrderLineEvent;
            expect(event).toBeInstanceOf(OrderLineEvent);
            expect(event.type).toBe('updated');
            expect(event.order).toBe(order);
            expect(event.orderLine).toBe(line);
        });

        it('does not touch stock movements for an active Order', async () => {
            const { order, line } = lineInOrder(1, { active: true, state: 'AddingItems' });

            await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);
            await orderModifier.updateOrderLineQuantity(ctx, line, 1, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createReleasesForOrderLines).not.toHaveBeenCalled();
        });

        it('does not touch stock movements for a Draft Order', async () => {
            const { order, line } = lineInOrder(1, { active: false, state: 'Draft' });

            await orderModifier.updateOrderLineQuantity(ctx, line, 3, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('allocates the additional quantity when increasing on a placed Order', async () => {
            const { order, line } = lineInOrder(2, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, line, 5, order);

            expect(stockMovementService.createAllocationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 5, quantity: 3 },
            ]);
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
        });

        it('cancels and releases down to the new quantity when decreasing on a placed Order', async () => {
            const { order, line } = lineInOrder(5, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, order);

            expect(stockMovementService.createCancellationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 5, quantity: 2 },
            ]);
            expect(stockMovementService.createReleasesForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 5, quantity: 2 },
            ]);
            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('creates no stock movements when the quantity is unchanged', async () => {
            const { order, line } = lineInOrder(2, { active: false, state: 'Modifying' });

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, order);

            expect(stockMovementService.createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createCancellationsForOrderLines).not.toHaveBeenCalled();
            expect(stockMovementService.createReleasesForOrderLines).not.toHaveBeenCalled();
            expect(orderLineRepo.save).toHaveBeenCalledWith(line);
        });
    });

    describe('cancelOrderByOrderLines()', () => {
        function lineBelongingTo(lineId: number, order: Order): OrderLine {
            return new OrderLine({ id: lineId, quantity: 1, order });
        }

        it('returns EmptyOrderLineSelectionError when no lines are given', async () => {
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

        it('returns MultipleOrderError when the lines span more than one Order', async () => {
            const orderA = new Order({ id: 1, channels: [channel] });
            const orderB = new Order({ id: 2, channels: [channel] });
            orderLineRepo.find.mockResolvedValue([lineBelongingTo(10, orderA), lineBelongingTo(20, orderB)]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 10, quantity: 1 },
                { orderLineId: 20, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns MultipleOrderError when the lines belong to a different Order than input.orderId', async () => {
            const order = new Order({ id: 1, channels: [channel] });
            orderLineRepo.find.mockResolvedValue([lineBelongingTo(10, order)]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 999 }, [
                { orderLineId: 10, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns CancelActiveOrderError with the Order state when the Order is still active', async () => {
            const order = new Order({ id: 1, active: true, state: 'AddingItems', channels: [channel] });
            orderLineRepo.find.mockResolvedValue([lineBelongingTo(10, order)]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 1 }, [
                { orderLineId: 10, quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(CancelActiveOrderError);
            expect((result as CancelActiveOrderError).orderState).toBe('AddingItems');
            expect(connection.getEntityOrThrow).not.toHaveBeenCalled();
        });
    });

    describe('modifyOrder()', () => {
        function modifyingOrder(): Order {
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
            order.id = 1;
            order.state = 'Modifying';
            order.surcharges = [];
            return order;
        }

        it('returns OrderModificationStateError when the Order is not in the Modifying state', async () => {
            const order = modifyingOrder();
            order.state = 'PaymentSettled';

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, addItems: [] },
                order,
            );

            expect(result).toBeInstanceOf(OrderModificationStateError);
        });

        it.each<[string, ModifyOrderInput]>([
            ['empty input', { orderId: 1, dryRun: false }],
            [
                'empty arrays',
                {
                    orderId: 1,
                    dryRun: false,
                    addItems: [],
                    adjustOrderLines: [],
                    surcharges: [],
                    shippingMethodIds: [],
                },
            ],
        ])('returns NoChangesSpecifiedError for %s', async (_, input) => {
            const result = await orderModifier.modifyOrder(ctx, input, modifyingOrder());

            expect(result).toBeInstanceOf(NoChangesSpecifiedError);
        });

        it('returns NegativeQuantityError for a negative addItems quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, addItems: [{ productVariantId: 100, quantity: -1 }] },
                modifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('returns NegativeQuantityError for a negative adjustOrderLines quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 1, dryRun: false, adjustOrderLines: [{ orderLineId: 1, quantity: -1 }] },
                modifyingOrder(),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('throws a UserInputError when adjusting a line the Order does not contain', async () => {
            let error: any;
            try {
                await orderModifier.modifyOrder(
                    ctx,
                    { orderId: 1, dryRun: false, adjustOrderLines: [{ orderLineId: 42, quantity: 1 }] },
                    modifyingOrder(),
                );
            } catch (e) {
                error = e;
            }

            expect(error).toBeInstanceOf(UserInputError);
            expect(error.message).toBe('error.order-does-not-contain-line-with-id');
            expect(error.variables).toEqual({ id: 42 });
        });
    });

    describe('setShippingMethods()', () => {
        it('returns IneligibleShippingMethodError when a method is not eligible', async () => {
            const order = createOrderFromLines([]);
            order.shippingLines = [];
            shippingCalculator.getMethodIfEligible.mockResolvedValue(undefined);

            const result = await orderModifier.setShippingMethods(ctx, order, [7]);

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
            expect(shippingCalculator.getMethodIfEligible).toHaveBeenCalledWith(ctx, order, 7);
            expect(connection.getRepository).not.toHaveBeenCalled();
        });
    });
});
