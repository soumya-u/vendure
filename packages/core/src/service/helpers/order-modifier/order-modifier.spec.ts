import { AdjustmentType, HistoryEntryType } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { EntityNotFoundError, UserInputError } from '../../../common/error/errors';
import {
    CancelActiveOrderError,
    CouponCodeInvalidError,
    EmptyOrderLineSelectionError,
    MultipleOrderError,
    NoChangesSpecifiedError,
    OrderModificationStateError,
    QuantityTooGreatError,
    RefundPaymentIdMissingError,
} from '../../../common/error/generated-graphql-admin-errors';
import {
    IneligibleShippingMethodError,
    InsufficientStockError,
    NegativeQuantityError,
    OrderLimitError,
} from '../../../common/error/generated-graphql-shop-errors';
import { ensureConfigLoaded } from '../../../config/config-helpers';
import { Channel } from '../../../entity/channel/channel.entity';
import { FulfillmentLine } from '../../../entity/order-line-reference/fulfillment-line.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { OrderModification } from '../../../entity/order-modification/order-modification.entity';
import { Order } from '../../../entity/order/order.entity';
import { Payment } from '../../../entity/payment/payment.entity';
import { ProductVariant } from '../../../entity/product-variant/product-variant.entity';
import { ShippingLine } from '../../../entity/shipping-line/shipping-line.entity';
import { Allocation } from '../../../entity/stock-movement/allocation.entity';
import { OrderLineEvent } from '../../../event-bus/events/order-line-event';

import { OrderModifier } from './order-modifier';

/**
 * Unit tests for the OrderModifier helper. The TypeORM repositories are replaced with in-memory
 * mocks so that each test can assert on the entities which get persisted, the stock movements
 * which get created, and the error results returned for invalid input.
 */

/**
 * Narrows a modifyOrder() result to the success case, failing the test otherwise.
 */
function expectSuccess(result: Awaited<ReturnType<OrderModifier['modifyOrder']>>): {
    order: Order;
    modification: OrderModification;
} {
    if (!('modification' in result)) {
        throw new Error(`Expected a successful modification, got ${JSON.stringify(result)}`);
    }
    return result;
}

let idCounter = 0;

function createCtx(): RequestContext {
    return new RequestContext({
        apiType: 'admin',
        channel: new Channel({ id: 'T_1', pricesIncludeTax: true }),
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        session: {} as any,
        translationFn: ((key: string) => key) as any,
    });
}

function createVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
    return new ProductVariant({
        id: 'T_1',
        listPrice: 1000,
        listPriceIncludesTax: true,
        product: { id: 'T_1', featuredAssetId: undefined },
        taxCategory: { id: 'T_1' },
        ...overrides,
    } as any);
}

function createLine(overrides: Partial<OrderLine> = {}): OrderLine {
    return new OrderLine({
        id: 'T_1',
        quantity: 1,
        productVariantId: 'T_1',
        productVariant: createVariant(),
        adjustments: [],
        taxLines: [],
        customFields: {},
        listPrice: 1000,
        listPriceIncludesTax: true,
        ...overrides,
    } as any);
}

function createOrder(overrides: Partial<Order> = {}): Order {
    return new Order({
        id: 'T_1',
        state: 'AddingItems',
        active: true,
        lines: [],
        surcharges: [],
        shippingLines: [],
        couponCodes: [],
        subTotalWithTax: 0,
        shippingWithTax: 0,
        ...overrides,
    } as any);
}

interface MockRepository {
    save: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    createQueryBuilder: ReturnType<typeof vi.fn>;
    getMany: ReturnType<typeof vi.fn>;
    relationAdd: ReturnType<typeof vi.fn>;
    relationSet: ReturnType<typeof vi.fn>;
    updateQuery: ReturnType<typeof vi.fn>;
}

function createMockRepository(): MockRepository {
    const getMany = vi.fn(async () => [] as any[]);
    const relationAdd = vi.fn(async () => undefined);
    const relationSet = vi.fn(async () => undefined);
    const updateQuery = vi.fn();
    const queryBuilder: any = {
        leftJoinAndSelect: () => queryBuilder,
        where: () => queryBuilder,
        andWhere: () => queryBuilder,
        whereInIds: () => queryBuilder,
        getMany,
        relation: () => queryBuilder,
        of: () => queryBuilder,
        add: relationAdd,
        set: relationSet,
        update: (...args: any[]) => {
            updateQuery(...args);
            return queryBuilder;
        },
        execute: async () => undefined,
    };
    return {
        save: vi.fn(async (entity: any) => {
            const assignId = (e: any) => {
                if (e && e.id == null) {
                    e.id = `T_${++idCounter + 100}`;
                }
                return e;
            };
            return Array.isArray(entity) ? entity.map(assignId) : assignId(entity);
        }),
        update: vi.fn(async () => undefined),
        remove: vi.fn(async (entities: any) => entities),
        find: vi.fn(async () => [] as any[]),
        findOne: vi.fn(async () => null),
        createQueryBuilder: vi.fn(() => queryBuilder),
        getMany,
        relationAdd,
        relationSet,
        updateQuery,
    };
}

describe('OrderModifier', () => {
    beforeAll(async () => {
        // the money-related entity getters read the MoneyStrategy from the global config
        await ensureConfigLoaded();
    });

    let ctx: RequestContext;
    let repositories: Map<any, MockRepository>;
    let orderModifier: OrderModifier;
    let getSaleableStockLevel: ReturnType<typeof vi.fn>;
    let applyChannelPriceAndTax: ReturnType<typeof vi.fn>;
    let findOneInChannel: ReturnType<typeof vi.fn>;
    let getEntityOrThrow: ReturnType<typeof vi.fn>;
    let createAllocationsForOrderLines: ReturnType<typeof vi.fn>;
    let createCancellationsForOrderLines: ReturnType<typeof vi.fn>;
    let createReleasesForOrderLines: ReturnType<typeof vi.fn>;
    let publish: ReturnType<typeof vi.fn>;
    let createHistoryEntryForOrder: ReturnType<typeof vi.fn>;
    let calculateOrderTotals: ReturnType<typeof vi.fn>;
    let applyPriceAdjustments: ReturnType<typeof vi.fn>;
    let getMethodIfEligible: ReturnType<typeof vi.fn>;
    let assignShippingLineToOrderLines: ReturnType<typeof vi.fn>;
    let setOrderLineSellerChannel: ((...args: any[]) => any) | undefined;
    let updateRelations: ReturnType<typeof vi.fn>;
    let validateCouponCode: ReturnType<typeof vi.fn>;
    let createRefund: ReturnType<typeof vi.fn>;
    let findOneByCode: ReturnType<typeof vi.fn>;
    let orderLineCustomFields: any[];
    let orderItemsLimit: number;
    let calculateUnitPrice: ReturnType<typeof vi.fn>;

    function repo(entity: any): MockRepository {
        let r = repositories.get(entity);
        if (!r) {
            r = createMockRepository();
            repositories.set(entity, r);
        }
        return r;
    }

    beforeEach(() => {
        ctx = createCtx();
        repositories = new Map();
        orderLineCustomFields = [];
        orderItemsLimit = 999;
        getSaleableStockLevel = vi.fn(async () => 100);
        applyChannelPriceAndTax = vi.fn(async (variant: ProductVariant) => variant);
        findOneInChannel = vi.fn(async () => createVariant());
        getEntityOrThrow = vi.fn(async () => createOrder());
        createAllocationsForOrderLines = vi.fn(async () => []);
        createCancellationsForOrderLines = vi.fn(async () => []);
        createReleasesForOrderLines = vi.fn(async () => []);
        publish = vi.fn(async () => undefined);
        createHistoryEntryForOrder = vi.fn(async () => undefined);
        calculateOrderTotals = vi.fn();
        applyPriceAdjustments = vi.fn(async () => undefined);
        getMethodIfEligible = vi.fn(async (_ctx: RequestContext, _order: Order, id: ID) => ({ id }));
        assignShippingLineToOrderLines = vi.fn(
            async (_ctx: RequestContext, _sl: any, order: Order) => order.lines,
        );
        setOrderLineSellerChannel = undefined;
        updateRelations = vi.fn(async () => undefined);
        validateCouponCode = vi.fn(async (_ctx: RequestContext, couponCode: string) => ({
            id: 'T_1',
            couponCode,
        }));
        createRefund = vi.fn(async () => ({ id: 'T_1' }));
        findOneByCode = vi.fn(async () => ({ name: 'Germany' }));
        calculateUnitPrice = vi.fn(async () => ({ price: 1000, priceIncludesTax: true }));

        const connection: any = {
            getRepository: (_ctx: RequestContext, entity: any) => repo(entity),
            getEntityOrThrow,
            findOneInChannel,
        };
        const configService: any = {
            get customFields() {
                return { OrderLine: orderLineCustomFields };
            },
            get orderOptions() {
                return {
                    get orderItemsLimit() {
                        return orderItemsLimit;
                    },
                    orderSellerStrategy: {
                        get setOrderLineSellerChannel() {
                            return setOrderLineSellerChannel;
                        },
                    },
                    orderItemPriceCalculationStrategy: { calculateUnitPrice },
                };
            },
            shippingOptions: { shippingLineAssignmentStrategy: { assignShippingLineToOrderLines } },
        };
        orderModifier = new OrderModifier(
            connection,
            configService,
            { calculateOrderTotals, applyPriceAdjustments } as any,
            { createRefund } as any,
            { findOneByCode } as any,
            {
                createAllocationsForOrderLines,
                createCancellationsForOrderLines,
                createReleasesForOrderLines,
            } as any,
            { getSaleableStockLevel, applyChannelPriceAndTax } as any,
            { updateRelations } as any,
            {
                validateCouponCode,
                getActivePromotionsInChannel: vi.fn(async () => []),
                getActivePromotionsOnOrder: vi.fn(async () => []),
                runPromotionSideEffects: vi.fn(async () => undefined),
            } as any,
            { publish } as any,
            { getMethodIfEligible } as any,
            { createHistoryEntryForOrder } as any,
            { translate: (entity: any) => entity } as any,
        );
    });

    describe('constrainQuantityToSaleable', () => {
        it('returns the requested quantity when there is enough stock', async () => {
            getSaleableStockLevel.mockResolvedValue(10);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5);

            expect(result).toBe(5);
        });

        it('caps the quantity at the saleable stock level', async () => {
            getSaleableStockLevel.mockResolvedValue(3);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5);

            expect(result).toBe(3);
        });

        it('adds the existing OrderLine quantity to the requested quantity', async () => {
            getSaleableStockLevel.mockResolvedValue(10);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5, 2);

            expect(result).toBe(7);
        });

        it('subtracts the existing OrderLine quantity when capping', async () => {
            getSaleableStockLevel.mockResolvedValue(6);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5, 2);

            expect(result).toBe(4);
        });

        it('takes the quantity in other OrderLines of the same variant into account', async () => {
            getSaleableStockLevel.mockResolvedValue(10);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5, 0, 8);

            expect(result).toBe(2);
        });

        it('never returns a negative quantity', async () => {
            getSaleableStockLevel.mockResolvedValue(1);

            const result = await orderModifier.constrainQuantityToSaleable(ctx, createVariant(), 5, 3, 4);

            expect(result).toBe(0);
        });
    });

    describe('getExistingOrderLine', () => {
        it('returns the line matching the ProductVariant id', async () => {
            const line = createLine({ id: 'T_2', productVariantId: 'T_42' } as any);
            const order = createOrder({ lines: [createLine({ productVariantId: 'T_1' } as any), line] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_42');

            expect(result).toBe(line);
        });

        it('returns undefined when no line contains the ProductVariant', async () => {
            const order = createOrder({ lines: [createLine({ productVariantId: 'T_1' } as any)] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_99');

            expect(result).toBeUndefined();
        });

        it('does not match a line whose custom field values differ from the input', async () => {
            orderLineCustomFields = [{ name: 'message', type: 'string' }];
            const order = createOrder({
                lines: [createLine({ customFields: { message: 'hello' } } as any)],
            });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', {
                message: 'goodbye',
            });

            expect(result).toBeUndefined();
        });

        it('matches a line whose custom field values equal the input', async () => {
            orderLineCustomFields = [{ name: 'message', type: 'string' }];
            const line = createLine({ customFields: { message: 'hello' } } as any);
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', {
                message: 'hello',
            });

            expect(result).toBe(line);
        });

        it('matches when an omitted custom field equals the configured default value', async () => {
            orderLineCustomFields = [{ name: 'message', type: 'string', defaultValue: 'hello' }];
            const line = createLine({ customFields: { message: 'hello' } } as any);
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', {});

            expect(result).toBe(line);
        });

        it('matches when an omitted custom field is null on the existing line', async () => {
            orderLineCustomFields = [{ name: 'message', type: 'string' }];
            const line = createLine({ customFields: { message: null } } as any);
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', {});

            expect(result).toBe(line);
        });

        it('treats a numeric 0/1 boolean custom field as a boolean', async () => {
            orderLineCustomFields = [{ name: 'giftWrap', type: 'boolean' }];
            const line = createLine({ customFields: { giftWrap: 1 } } as any);
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', { giftWrap: true });

            expect(result).toBe(line);
        });

        describe('with null customFields input', () => {
            it('matches a line whose custom fields are all null', async () => {
                orderLineCustomFields = [{ name: 'message', type: 'string' }];
                const line = createLine({ customFields: { message: null } } as any);
                const order = createOrder({ lines: [line] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', null as any);

                expect(result).toBe(line);
            });

            it('does not match a line with a non-default custom field value', async () => {
                orderLineCustomFields = [{ name: 'message', type: 'string' }];
                const order = createOrder({
                    lines: [createLine({ customFields: { message: 'hello' } } as any)],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', null as any);

                expect(result).toBeUndefined();
            });

            it('matches a line whose custom field equals the default value', async () => {
                orderLineCustomFields = [{ name: 'message', type: 'string', defaultValue: 'hello' }];
                const line = createLine({ customFields: { message: 'hello' } } as any);
                const order = createOrder({ lines: [line] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', null as any);

                expect(result).toBe(line);
            });

            it('does not match a line whose list custom field is not empty', async () => {
                orderLineCustomFields = [{ name: 'tags', type: 'string', list: true }];
                const order = createOrder({
                    lines: [createLine({ customFields: { tags: ['gift'] } } as any)],
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', null as any);

                expect(result).toBeUndefined();
            });

            it('matches a line whose list custom field is empty', async () => {
                orderLineCustomFields = [{ name: 'tags', type: 'string', list: true }];
                const line = createLine({ customFields: { tags: [] } } as any);
                const order = createOrder({ lines: [line] });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', null as any);

                expect(result).toBe(line);
            });
        });

        describe('relation custom fields', () => {
            beforeEach(() => {
                orderLineCustomFields = [{ name: 'gift', type: 'relation', entity: ProductVariant }];
            });

            it('matches when the input id equals the id of the related entity', async () => {
                const line = createLine();
                const order = createOrder({ lines: [line] });
                repo(OrderLine).findOne.mockResolvedValue({ customFields: { gift: { id: 'T_5' } } });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', { giftId: 'T_5' });

                expect(result).toBe(line);
            });

            it('does not match when the input id differs from the related entity', async () => {
                const order = createOrder({ lines: [createLine()] });
                repo(OrderLine).findOne.mockResolvedValue({ customFields: { gift: { id: 'T_5' } } });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', { giftId: 'T_6' });

                expect(result).toBeUndefined();
            });

            it('compares list relations irrespective of the order of the ids', async () => {
                orderLineCustomFields = [
                    { name: 'gift', type: 'relation', entity: ProductVariant, list: true },
                ];
                const line = createLine();
                const order = createOrder({ lines: [line] });
                repo(OrderLine).findOne.mockResolvedValue({
                    customFields: { gift: [{ id: 'T_5' }, { id: 'T_6' }] },
                });

                const result = await orderModifier.getExistingOrderLine(ctx, order, 'T_1', {
                    giftIds: ['T_6', 'T_5'],
                });

                expect(result).toBe(line);
            });
        });
    });

    describe('getOrCreateOrderLine', () => {
        it('returns the existing OrderLine without creating a new one', async () => {
            const line = createLine();
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 'T_1');

            expect(result).toBe(line);
            expect(repo(OrderLine).save).not.toHaveBeenCalled();
            expect(order.lines.length).toBe(1);
        });

        it('creates a new OrderLine from the ProductVariant with zero quantity', async () => {
            const order = createOrder();
            findOneInChannel.mockResolvedValue(
                createVariant({ id: 'T_7', listPrice: 2500, listPriceIncludesTax: false } as any),
            );

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 'T_7');

            expect(result.quantity).toBe(0);
            expect(result.listPrice).toBe(2500);
            expect(result.listPriceIncludesTax).toBe(false);
            expect(order.lines).toContain(result);
            expect(repo(Order).relationAdd).toHaveBeenCalledWith(result);
        });

        it('applies the channel price and tax to the new line variant', async () => {
            const order = createOrder();

            await orderModifier.getOrCreateOrderLine(ctx, order, 'T_1');

            expect(applyChannelPriceAndTax).toHaveBeenCalledWith(expect.any(ProductVariant), ctx, order);
        });

        it('falls back to the Product featured asset when the variant has none', async () => {
            findOneInChannel.mockResolvedValue(
                createVariant({ featuredAssetId: undefined, product: { featuredAssetId: 'T_9' } } as any),
            );

            const result = await orderModifier.getOrCreateOrderLine(ctx, createOrder(), 'T_1');

            expect(result.featuredAsset).toEqual({ id: 'T_9' });
        });

        it('publishes an OrderLineEvent for the created line', async () => {
            const order = createOrder();

            const result = await orderModifier.getOrCreateOrderLine(ctx, order, 'T_1');

            expect(publish).toHaveBeenCalledTimes(1);
            const event = publish.mock.calls[0][0];
            expect(event).toBeInstanceOf(OrderLineEvent);
            expect(event.type).toBe('created');
            expect(event.orderLine).toBe(result);
        });

        it('assigns the seller Channel when the OrderSellerStrategy provides one', async () => {
            const sellerChannel = new Channel({ id: 'T_2' });
            setOrderLineSellerChannel = vi.fn(async () => sellerChannel);

            const result = await orderModifier.getOrCreateOrderLine(ctx, createOrder(), 'T_1');

            expect(result.sellerChannel).toBe(sellerChannel);
            expect(repo(OrderLine).relationSet).toHaveBeenCalledWith(sellerChannel);
        });

        it('throws when the ProductVariant does not exist in the Channel', async () => {
            findOneInChannel.mockResolvedValue(undefined);

            await expect(orderModifier.getOrCreateOrderLine(ctx, createOrder(), 'T_1')).rejects.toThrow(
                EntityNotFoundError,
            );
        });
    });

    describe('updateOrderLineQuantity', () => {
        it('updates the quantity and saves the line', async () => {
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ lines: [line] });

            const result = await orderModifier.updateOrderLineQuantity(ctx, line, 4, order);

            expect(result.quantity).toBe(4);
            expect(repo(OrderLine).save).toHaveBeenCalledWith(line);
        });

        it('does not create stock movements for an active Order', async () => {
            const line = createLine({ quantity: 1 } as any);

            await orderModifier.updateOrderLineQuantity(ctx, line, 4, createOrder({ active: true }));

            expect(createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('allocates the additional quantity for an inactive Order', async () => {
            const line = createLine({ quantity: 1 } as any);

            await orderModifier.updateOrderLineQuantity(ctx, line, 4, createOrder({ active: false }));

            expect(createAllocationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: line.id, quantity: 3 },
            ]);
        });

        it('does not allocate stock for a Draft Order', async () => {
            const line = createLine({ quantity: 1 } as any);

            await orderModifier.updateOrderLineQuantity(
                ctx,
                line,
                4,
                createOrder({ active: false, state: 'Draft' } as any),
            );

            expect(createAllocationsForOrderLines).not.toHaveBeenCalled();
        });

        it('cancels and releases stock when reducing the quantity on an inactive Order', async () => {
            const line = createLine({ quantity: 5 } as any);

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, createOrder({ active: false }));

            expect(createCancellationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: line.id, quantity: 2 },
            ]);
            expect(createReleasesForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: line.id, quantity: 2 },
            ]);
        });

        it('creates no stock movements when the quantity is unchanged', async () => {
            const line = createLine({ quantity: 3 } as any);

            await orderModifier.updateOrderLineQuantity(ctx, line, 3, createOrder({ active: false }));

            expect(createAllocationsForOrderLines).not.toHaveBeenCalled();
            expect(createCancellationsForOrderLines).not.toHaveBeenCalled();
        });

        it('publishes an "updated" OrderLineEvent', async () => {
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ lines: [line] });

            await orderModifier.updateOrderLineQuantity(ctx, line, 2, order);

            expect(publish.mock.calls[0][0].type).toBe('updated');
        });
    });

    describe('cancelOrderByOrderLines', () => {
        function setUpOrderForCancellation(order: Order, lines: OrderLine[]) {
            repo(OrderLine).getMany.mockResolvedValue(
                lines.map(l => ({ id: l.id, order, quantity: l.quantity })),
            );
            getEntityOrThrow.mockResolvedValue(order);
        }

        beforeEach(() => {
            // `getOrdersFromLines` looks the OrderLines up via the repository `find` method
            repo(OrderLine).find.mockImplementation(async () => []);
        });

        it('returns EmptyOrderLineSelectionError for an empty selection', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, []);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
        });

        it('returns EmptyOrderLineSelectionError when all quantities are zero', async () => {
            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 0 },
            ]);

            expect(result).toBeInstanceOf(EmptyOrderLineSelectionError);
        });

        it('returns MultipleOrderError when the lines belong to more than one Order', async () => {
            const orderA = createOrder({ id: 'T_1', channels: [ctx.channel] } as any);
            const orderB = createOrder({ id: 'T_2', channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([
                { id: 'T_1', order: orderA },
                { id: 'T_2', order: orderB },
            ]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
                { orderLineId: 'T_2', quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns MultipleOrderError when the lines belong to a different Order than the input', async () => {
            const order = createOrder({ id: 'T_2', channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: 'T_1', order }]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(MultipleOrderError);
        });

        it('returns CancelActiveOrderError for an active Order', async () => {
            const order = createOrder({ active: true, channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: 'T_1', order }]);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(result).toBeInstanceOf(CancelActiveOrderError);
            expect((result as CancelActiveOrderError).orderState).toBe('AddingItems');
        });

        it('returns QuantityTooGreatError when cancelling more than the line contains', async () => {
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 5 },
            ]);

            expect(result).toBeInstanceOf(QuantityTooGreatError);
        });

        it('creates cancellations for fulfilled items and releases for allocated items', async () => {
            const line = createLine({ quantity: 5 } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);
            repo(Allocation).getMany.mockResolvedValue([{ quantity: 4 }]);
            repo(FulfillmentLine).getMany.mockResolvedValue([{ quantity: 1 }]);

            await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 2 },
            ]);

            expect(createCancellationsForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);
            expect(createReleasesForOrderLines).toHaveBeenCalledWith(ctx, [
                { orderLineId: 'T_1', quantity: 2 },
            ]);
        });

        it('reduces the line quantity and rescales its promotion adjustments', async () => {
            const line = createLine({
                quantity: 4,
                adjustments: [{ type: AdjustmentType.PROMOTION, amount: -400 } as any],
            } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(line.quantity).toBe(3);
            expect(line.adjustments[0].amount).toBe(-300);
            expect(repo(OrderLine).update).toHaveBeenCalledWith('T_1', {
                quantity: 3,
                adjustments: line.adjustments,
            });
        });

        it('adds a cancellation adjustment to the ShippingLines when cancelShipping is set', async () => {
            const line = createLine({ quantity: 1 } as any);
            const shippingLine = new ShippingLine({
                id: 'T_1',
                adjustments: [],
                listPriceIncludesTax: true,
                listPrice: 500,
                taxLines: [],
            } as any);
            const order = createOrder({
                active: false,
                lines: [line],
                shippingLines: [shippingLine],
                channels: [ctx.channel],
            } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1', cancelShipping: true }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(shippingLine.adjustments.length).toBe(1);
            expect(shippingLine.adjustments[0]).toMatchObject({
                adjustmentSource: 'CANCEL_ORDER',
                amount: -500,
            });
        });

        it('leaves the ShippingLines alone when cancelShipping is not set', async () => {
            const line = createLine({ quantity: 1 } as any);
            const shippingLine = new ShippingLine({
                id: 'T_1',
                adjustments: [],
                listPriceIncludesTax: true,
                listPrice: 500,
                taxLines: [],
            } as any);
            const order = createOrder({
                active: false,
                lines: [line],
                shippingLines: [shippingLine],
                channels: [ctx.channel],
            } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(shippingLine.adjustments).toEqual([]);
        });

        it('recalculates the Order totals and records a history entry', async () => {
            const line = createLine({ quantity: 2 } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1', reason: 'changed mind' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(calculateOrderTotals).toHaveBeenCalledWith(order);
            expect(createHistoryEntryForOrder).toHaveBeenCalledWith({
                ctx,
                orderId: 'T_1',
                type: HistoryEntryType.ORDER_CANCELLATION,
                data: {
                    lines: [{ orderLineId: 'T_1', quantity: 1 }],
                    reason: 'changed mind',
                    shippingCancelled: false,
                },
            });
        });

        it('returns true when every line has been fully cancelled', async () => {
            const line = createLine({ quantity: 2 } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 2 },
            ]);

            expect(result).toBe(true);
        });

        it('returns false when some quantity remains on the Order', async () => {
            const line = createLine({ quantity: 2 } as any);
            const order = createOrder({ active: false, lines: [line], channels: [ctx.channel] } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: line.id, order }]);
            getEntityOrThrow.mockResolvedValue(order);

            const result = await orderModifier.cancelOrderByOrderLines(ctx, { orderId: 'T_1' }, [
                { orderLineId: 'T_1', quantity: 1 },
            ]);

            expect(result).toBe(false);
        });
    });

    describe('setShippingMethods', () => {
        it('returns IneligibleShippingMethodError when the method is not eligible', async () => {
            getMethodIfEligible.mockResolvedValue(undefined);

            const result = await orderModifier.setShippingMethods(ctx, createOrder(), ['T_1']);

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
        });

        it('throws when the Order has no shippingLines array at all', async () => {
            // `order.shippingLines[i]` is read before the `if (order.shippingLines)` fallback,
            // so the fallback branch is unreachable.
            const order = createOrder({ lines: [createLine()] });
            (order as any).shippingLines = undefined;

            await expect(orderModifier.setShippingMethods(ctx, order, ['T_2'])).rejects.toThrow(TypeError);
        });

        it('creates a ShippingLine when the Order has none', async () => {
            const order = createOrder({ lines: [createLine()] });

            const result = await orderModifier.setShippingMethods(ctx, order, ['T_2']);

            expect(result).toBe(order);
            expect(order.shippingLines.length).toBe(1);
            expect(order.shippingLines[0].shippingMethod).toEqual({ id: 'T_2' });
            expect(order.shippingLines[0].listPriceIncludesTax).toBe(true);
        });

        it('updates the ShippingMethod of an existing ShippingLine rather than creating one', async () => {
            const shippingLine = new ShippingLine({ id: 'T_1', adjustments: [], taxLines: [] } as any);
            const order = createOrder({ lines: [createLine()], shippingLines: [shippingLine] });

            await orderModifier.setShippingMethods(ctx, order, ['T_5']);

            expect(order.shippingLines).toEqual([shippingLine]);
            expect(shippingLine.shippingMethodId).toBe('T_5');
        });

        it('assigns the ShippingLine to the OrderLines via the assignment strategy', async () => {
            const line = createLine();
            const order = createOrder({ lines: [line] });

            await orderModifier.setShippingMethods(ctx, order, ['T_2']);

            expect(assignShippingLineToOrderLines).toHaveBeenCalledWith(ctx, order.shippingLines[0], order);
            expect(line.shippingLine).toBe(order.shippingLines[0]);
        });

        it('removes surplus ShippingLines, but off by one: the last kept line is removed too', async () => {
            // With 1 shippingMethodId and 2 existing lines, `splice(shippingMethodIds.length - 1)`
            // removes from index 0, i.e. it also removes the line which was just assigned.
            const lineA = new ShippingLine({ id: 'T_1', adjustments: [], taxLines: [] } as any);
            const lineB = new ShippingLine({ id: 'T_2', adjustments: [], taxLines: [] } as any);
            const order = createOrder({ lines: [createLine()], shippingLines: [lineA, lineB] });

            await orderModifier.setShippingMethods(ctx, order, ['T_5']);

            expect(repo(ShippingLine).remove).toHaveBeenCalledWith([lineA, lineB]);
            expect(order.shippingLines).toEqual([]);
        });
    });

    describe('modifyOrder', () => {
        it('returns OrderModificationStateError unless the Order is in the Modifying state', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, addItems: [{ productVariantId: 'T_1', quantity: 1 }] },
                createOrder({ state: 'PaymentSettled' } as any),
            );

            expect(result).toBeInstanceOf(OrderModificationStateError);
        });

        it('returns NoChangesSpecifiedError when the input contains no changes', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, shippingMethodIds: [] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(NoChangesSpecifiedError);
        });

        it('returns NegativeQuantityError for a negative addItems quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, addItems: [{ productVariantId: 'T_1', quantity: -1 }] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('returns NegativeQuantityError for a negative adjustOrderLines quantity', async () => {
            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, adjustOrderLines: [{ orderLineId: 'T_1', quantity: -1 }] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(NegativeQuantityError);
        });

        it('returns OrderLimitError when the added items exceed the order items limit', async () => {
            orderItemsLimit = 2;

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, addItems: [{ productVariantId: 'T_1', quantity: 3 }] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(OrderLimitError);
            expect((result as OrderLimitError).maxItems).toBe(2);
        });

        it('returns InsufficientStockError when the requested quantity is not saleable', async () => {
            getSaleableStockLevel.mockResolvedValue(1);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, addItems: [{ productVariantId: 'T_1', quantity: 3 }] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(InsufficientStockError);
            expect((result as InsufficientStockError).quantityAvailable).toBe(1);
        });

        it('throws when adjusting an OrderLine which is not part of the Order', async () => {
            await expect(
                orderModifier.modifyOrder(
                    ctx,
                    {
                        orderId: 'T_1',
                        dryRun: false,
                        adjustOrderLines: [{ orderLineId: 'T_99', quantity: 1 }],
                    },
                    createOrder({ state: 'Modifying' } as any),
                ),
            ).rejects.toThrow(UserInputError);
        });

        it('adds the requested items and records them on the modification (dry run)', async () => {
            const order = createOrder({ state: 'Modifying' } as any);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, addItems: [{ productVariantId: 'T_1', quantity: 2 }] },
                order,
            );

            const { modification } = expectSuccess(result);
            expect(order.lines.length).toBe(1);
            expect(order.lines[0].quantity).toBe(2);
            expect(modification.lines.length).toBe(1);
            expect(modification.lines[0].quantity).toBe(2);
            // a dry run must not persist the modification
            expect(applyPriceAdjustments).toHaveBeenCalled();
        });

        it('adds a surcharge to the Order', async () => {
            const order = createOrder({ state: 'Modifying' } as any);

            const result = await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: true,
                    surcharges: [{ description: 'Extra fee', price: 500, priceIncludesTax: true }],
                },
                order,
            );

            expect(order.surcharges.length).toBe(1);
            expect(order.surcharges[0].description).toBe('Extra fee');
            expect(expectSuccess(result).modification.surcharges).toEqual(order.surcharges);
        });

        it('updates the shipping address and resolves the country name', async () => {
            const order = createOrder({
                state: 'Modifying',
                shippingAddress: { streetLine1: 'Old Street' },
            } as any);

            await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: true,
                    updateShippingAddress: { streetLine1: 'New Street', countryCode: 'DE' },
                },
                order,
            );

            expect(order.shippingAddress.streetLine1).toBe('New Street');
            expect(order.shippingAddress.country).toBe('Germany');
            expect(findOneByCode).toHaveBeenCalledWith(ctx, 'DE');
        });

        it('returns OrderLimitError when an adjusted line exceeds the order items limit', async () => {
            orderItemsLimit = 2;
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ state: 'Modifying', lines: [line] } as any);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, adjustOrderLines: [{ orderLineId: 'T_1', quantity: 5 }] },
                order,
            );

            expect(result).toBeInstanceOf(OrderLimitError);
        });

        it('resolves the country name when the billing address country changes', async () => {
            const order = createOrder({ state: 'Modifying', billingAddress: {} } as any);

            await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, updateBillingAddress: { countryCode: 'DE' } },
                order,
            );

            expect(order.billingAddress.country).toBe('Germany');
            expect(findOneByCode).toHaveBeenCalledWith(ctx, 'DE');
        });

        it('updates the billing address', async () => {
            const order = createOrder({
                state: 'Modifying',
                billingAddress: { streetLine1: 'Old Street', country: 'France' },
            } as any);

            await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, updateBillingAddress: { streetLine1: 'New Street' } },
                order,
            );

            expect(order.billingAddress).toMatchObject({
                streetLine1: 'New Street',
                country: 'France',
            });
            expect(findOneByCode).not.toHaveBeenCalled();
        });

        it('applies coupon codes and records a history entry for newly-applied codes', async () => {
            const order = createOrder({ state: 'Modifying', couponCodes: ['OLD'] } as any);

            await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, couponCodes: ['NEW'] },
                order,
            );

            expect(order.couponCodes).toEqual(['NEW']);
            const types = createHistoryEntryForOrder.mock.calls.map(call => call[0].type);
            expect(types).toEqual([
                HistoryEntryType.ORDER_COUPON_APPLIED,
                HistoryEntryType.ORDER_COUPON_REMOVED,
            ]);
        });

        it('returns the coupon code validation error', async () => {
            const invalidResult = new CouponCodeInvalidError({ couponCode: 'BAD' });
            validateCouponCode.mockResolvedValue(invalidResult);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, couponCodes: ['BAD'] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBe(invalidResult);
        });

        it('returns RefundPaymentIdMissingError when the total decreases with no refund input', async () => {
            const line = createLine({ quantity: 2 } as any);
            const order = createOrder({
                state: 'Modifying',
                active: false,
                lines: [line],
                subTotalWithTax: 2000,
                channels: [ctx.channel],
            } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: 'T_1', order }]);
            getEntityOrThrow.mockResolvedValue(order);
            // The Order total drops as a result of the price adjustment step
            applyPriceAdjustments.mockImplementation(async () => {
                order.subTotalWithTax = 1000;
            });

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, adjustOrderLines: [{ orderLineId: 'T_1', quantity: 1 }] },
                order,
            );

            expect(result).toBeInstanceOf(RefundPaymentIdMissingError);
        });

        it('creates a Refund against the matching Payment when the total decreases', async () => {
            const line = createLine({ quantity: 2 } as any);
            const order = createOrder({
                state: 'Modifying',
                active: false,
                lines: [line],
                subTotalWithTax: 2000,
                channels: [ctx.channel],
            } as any);
            repo(OrderLine).find.mockResolvedValue([{ id: 'T_1', order }]);
            getEntityOrThrow.mockResolvedValue(order);
            const payment = new Payment({ id: 'T_3', amount: 2000, state: 'Settled' } as any);
            repo(Payment).find.mockResolvedValue([payment]);
            applyPriceAdjustments.mockImplementation(async () => {
                order.subTotalWithTax = 1000;
            });

            const result = await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: false,
                    adjustOrderLines: [{ orderLineId: 'T_1', quantity: 1 }],
                    refunds: [{ paymentId: 'T_3', amount: 1000 }],
                },
                order,
            );

            expect(createRefund).toHaveBeenCalledTimes(1);
            expect(createRefund.mock.calls[0][3]).toBe(payment);
            if ('modification' in result) {
                expect(result.modification.priceChange).toBe(-1000);
                expect(result.modification.refund).toEqual({ id: 'T_1' });
            } else {
                throw new Error('Expected a successful result');
            }
        });

        it('persists the modification and publishes an OrderEvent when not a dry run', async () => {
            const order = createOrder({ state: 'Modifying' } as any);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, addItems: [{ productVariantId: 'T_1', quantity: 1 }] },
                order,
            );

            if ('modification' in result) {
                expect(result.modification.priceChange).toBe(0);
            } else {
                throw new Error('Expected a successful result');
            }
            expect(publish.mock.calls.some(call => call[0].type === 'updated')).toBe(true);
        });

        it('recalculates the unit price of updated lines using the price calculation strategy', async () => {
            const order = createOrder({ state: 'Modifying' } as any);
            calculateUnitPrice.mockResolvedValue({ price: 4321, priceIncludesTax: false });

            await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, addItems: [{ productVariantId: 'T_1', quantity: 1 }] },
                order,
            );

            expect(order.lines[0].listPrice).toBe(4321);
            expect(order.lines[0].listPriceIncludesTax).toBe(false);
        });

        it('returns the shipping method error when the new ShippingMethod is ineligible', async () => {
            getMethodIfEligible.mockResolvedValue(undefined);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, shippingMethodIds: ['T_1'] },
                createOrder({ state: 'Modifying' } as any),
            );

            expect(result).toBeInstanceOf(IneligibleShippingMethodError);
        });

        it('increases the quantity of an existing OrderLine', async () => {
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ state: 'Modifying', lines: [line] } as any);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, adjustOrderLines: [{ orderLineId: 'T_1', quantity: 3 }] },
                order,
            );

            expect(line.quantity).toBe(3);
            expect(expectSuccess(result).modification.lines[0].quantity).toBe(2);
        });

        it('returns InsufficientStockError when increasing beyond the saleable stock', async () => {
            const line = createLine({ quantity: 1 } as any);
            const order = createOrder({ state: 'Modifying', lines: [line] } as any);
            getSaleableStockLevel.mockResolvedValue(1);

            const result = await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: false, adjustOrderLines: [{ orderLineId: 'T_1', quantity: 3 }] },
                order,
            );

            expect(result).toBeInstanceOf(InsufficientStockError);
            expect((result as InsufficientStockError).quantityAvailable).toBe(2);
        });

        it('patches OrderLine custom fields when adjusting a line', async () => {
            const line = createLine({ quantity: 1, customFields: { message: 'old' } } as any);
            const order = createOrder({ state: 'Modifying', lines: [line] } as any);

            await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: true,
                    adjustOrderLines: [
                        { orderLineId: 'T_1', quantity: 1, customFields: { message: 'new' } } as any,
                    ],
                },
                order,
            );

            expect(line.customFields).toEqual({ message: 'new' });
        });

        it('adds a tax line to a surcharge with a tax rate', async () => {
            const order = createOrder({ state: 'Modifying' } as any);

            await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: true,
                    surcharges: [
                        {
                            description: 'Fee',
                            price: 500,
                            priceIncludesTax: true,
                            taxRate: 20,
                            taxDescription: 'VAT',
                        },
                    ],
                },
                order,
            );

            expect(order.surcharges[0].taxLines).toEqual([{ taxRate: 20, description: 'VAT' }]);
        });

        it('increases the refund adjustment by the value of a negative surcharge', async () => {
            const order = createOrder({
                state: 'Modifying',
                subTotalWithTax: 2000,
                shippingWithTax: 500,
            } as any);
            repo(Payment).find.mockResolvedValue([
                new Payment({ id: 'T_3', amount: 2500, state: 'Settled' } as any),
            ]);
            applyPriceAdjustments.mockImplementation(async () => {
                order.subTotalWithTax = 1500;
                order.shippingWithTax = 0;
            });

            await orderModifier.modifyOrder(
                ctx,
                {
                    orderId: 'T_1',
                    dryRun: false,
                    surcharges: [{ description: 'Discount', price: -500, priceIncludesTax: true }],
                    refund: { paymentId: 'T_3' },
                },
                order,
            );

            const refundInput = createRefund.mock.calls[0][1];
            expect(refundInput.shipping).toBe(500);
            // 500 from the negative surcharge, plus the adjustment needed to reach the delta of 1000
            expect(refundInput.adjustment).toBe(500);
        });

        it('throws when the Refund could not be created', async () => {
            const order = createOrder({ state: 'Modifying', subTotalWithTax: 2000 } as any);
            repo(Payment).find.mockResolvedValue([
                new Payment({ id: 'T_3', amount: 2000, state: 'Settled' } as any),
            ]);
            createRefund.mockResolvedValue({
                errorCode: 'REFUND_ORDER_STATE_ERROR',
                message: 'Cannot refund',
                __typename: 'RefundOrderStateError',
            });
            applyPriceAdjustments.mockImplementation(async () => {
                order.subTotalWithTax = 1000;
            });

            await expect(
                orderModifier.modifyOrder(
                    ctx,
                    {
                        orderId: 'T_1',
                        dryRun: false,
                        surcharges: [{ description: 'Discount', price: -1000, priceIncludesTax: true }],
                        refunds: [{ paymentId: 'T_3', amount: 1000 }],
                    },
                    order,
                ),
            ).rejects.toThrow('Cannot refund');
        });

        it('patches Order custom fields from the input', async () => {
            const order = createOrder({
                state: 'Modifying',
                customFields: { note: 'old', other: 'unchanged' },
            } as any);

            await orderModifier.modifyOrder(
                ctx,
                { orderId: 'T_1', dryRun: true, customFields: { note: 'hello' } } as any,
                order,
            );

            expect(order.customFields).toEqual({ note: 'hello', other: 'unchanged' });
        });
    });
});
