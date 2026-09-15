import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../api/common/request-context';
import { Injector } from '../../common/injector';
import { LocaleString } from '../../common/types/locale-types';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Customer } from '../../entity/customer/customer.entity';
import { Fulfillment } from '../../entity/fulfillment/fulfillment.entity';
import { FulfillmentLine } from '../../entity/order-line-reference/fulfillment-line.entity';
import { OrderModification } from '../../entity/order-modification/order-modification.entity';
import { Order } from '../../entity/order/order.entity';
import { Payment } from '../../entity/payment/payment.entity';
import { ShippingLine } from '../../entity/shipping-line/shipping-line.entity';
import { EventBus } from '../../event-bus/event-bus';
import { OrderPlacedEvent } from '../../event-bus/events/order-placed-event';
import { OrderSplitter } from '../../service/helpers/order-splitter/order-splitter';
import { OrderState } from '../../service/helpers/order-state-machine/order-state';
import { HistoryService } from '../../service/services/history.service';
import { ProductVariantService } from '../../service/services/product-variant.service';
import { StockLevelService } from '../../service/services/stock-level.service';
import { StockMovementService } from '../../service/services/stock-movement.service';
import { createOrderFromLines } from '../../testing/order-test-utils';
import { ConfigService } from '../config.service';
import { MockConfigService } from '../config.service.mock';

import { configureDefaultOrderProcess, DefaultOrderProcessOptions } from './default-order-process';
import { OrderProcess } from './order-process';

/**
 * Stands in for the TransactionalConnection. Each entity class maps to a canned repository
 * whose `find()` resolves to the given rows and whose `update()` is recorded.
 */
function createMockConnection(rows: Map<any, any[]> = new Map()) {
    const update = vi.fn().mockResolvedValue(undefined);
    const find = vi.fn();
    const getEntityOrThrow = vi.fn();
    const connection = {
        getRepository: (_ctx: RequestContext, entity: any) => ({
            find: (...args: any[]) => {
                find(entity, ...args);
                return Promise.resolve(rows.get(entity) ?? []);
            },
            update,
        }),
        getEntityOrThrow,
    } as unknown as TransactionalConnection;
    return { connection, update, find, getEntityOrThrow };
}

describe('configureDefaultOrderProcess()', () => {
    const ctx = RequestContext.empty();
    let process: OrderProcess<OrderState>;
    let mocks: ReturnType<typeof createMockConnection>;
    let configService: MockConfigService;
    let productVariantService: { getSaleableStockLevel: ReturnType<typeof vi.fn> };
    let eventBus: { publish: ReturnType<typeof vi.fn> };
    let stockMovementService: { createAllocationsForOrder: ReturnType<typeof vi.fn> };
    let historyService: { createHistoryEntryForOrder: ReturnType<typeof vi.fn> };
    let orderSplitter: { createSellerOrders: ReturnType<typeof vi.fn> };
    let orderPlacedStrategy: { shouldSetAsPlaced: ReturnType<typeof vi.fn> };
    let stockAllocationStrategy: { shouldAllocateStock: ReturnType<typeof vi.fn> };

    async function setup(options: DefaultOrderProcessOptions = {}, rows?: Map<any, any[]>) {
        mocks = createMockConnection(rows);
        configService = new MockConfigService();
        orderPlacedStrategy = { shouldSetAsPlaced: vi.fn().mockReturnValue(false) };
        stockAllocationStrategy = { shouldAllocateStock: vi.fn().mockResolvedValue(false) };
        configService.orderOptions = {
            orderPlacedStrategy: orderPlacedStrategy as any,
            stockAllocationStrategy: stockAllocationStrategy as any,
        };
        productVariantService = { getSaleableStockLevel: vi.fn().mockResolvedValue(100) };
        eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
        stockMovementService = { createAllocationsForOrder: vi.fn().mockResolvedValue(undefined) };
        historyService = { createHistoryEntryForOrder: vi.fn().mockResolvedValue(undefined) };
        orderSplitter = { createSellerOrders: vi.fn().mockResolvedValue([]) };

        const providers = new Map<any, any>([
            [TransactionalConnection, mocks.connection],
            [ProductVariantService, productVariantService],
            [ConfigService, configService],
            [EventBus, eventBus],
            [StockMovementService, stockMovementService],
            [StockLevelService, {}],
            [HistoryService, historyService],
            [OrderSplitter, orderSplitter],
        ]);
        const injector = new Injector({
            get: (token: any) => {
                if (!providers.has(token)) {
                    throw new Error(`No provider for ${String(token?.name ?? token)}`);
                }
                return providers.get(token);
            },
        } as any);
        process = configureDefaultOrderProcess(options);
        await process.init?.(injector);
    }

    function transitionStart(from: OrderState, to: OrderState, order: Order) {
        return process.onTransitionStart!(from, to, { ctx, order });
    }

    function transitionEnd(from: OrderState, to: OrderState, order: Order) {
        return process.onTransitionEnd!(from, to, { ctx, order });
    }

    function createReadyOrder(): Order {
        const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
        order.id = 1;
        order.subTotalWithTax = 0;
        order.shippingWithTax = 0;
        order.customer = new Customer({ id: 1 });
        order.shippingLines = [new ShippingLine({ id: 1 })];
        order.lines[0].productVariant.name = 'Variant A' as LocaleString;
        return order;
    }

    describe('transitions', () => {
        it('defines the default state graph', async () => {
            await setup();
            expect(process.transitions?.AddingItems.to).toEqual(['ArrangingPayment', 'Cancelled']);
            expect(process.transitions?.Cancelled.to).toEqual([]);
            expect(process.transitions?.Modifying.to).toContain('ArrangingAdditionalPayment');
        });
    });

    describe('onTransitionStart: Modifying', () => {
        it('blocks leaving Modifying when a modification is unsettled', async () => {
            const modification = new OrderModification({ priceChange: 100 });
            await setup({}, new Map([[OrderModification, [modification]]]));
            const order = createReadyOrder();

            const result = await transitionStart('Modifying', 'PaymentSettled', order);

            expect(result).toBe('message.cannot-transition-without-modification-payment');
            expect(mocks.find).toHaveBeenCalledWith(
                OrderModification,
                expect.objectContaining({ where: { order: { id: 1 } } }),
            );
        });

        it('allows leaving Modifying when all modifications are settled', async () => {
            const modification = new OrderModification({ priceChange: 100, payment: new Payment() });
            await setup({}, new Map([[OrderModification, [modification]]]));
            const order = createReadyOrder();
            order.payments = [new Payment({ state: 'Settled', amount: 0 })];

            const result = await transitionStart('Modifying', 'PaymentSettled', order);

            expect(result).toBeUndefined();
        });

        it('blocks Modifying -> ArrangingAdditionalPayment when nothing is owed', async () => {
            const modification = new OrderModification({ priceChange: 0 });
            await setup({}, new Map([[OrderModification, [modification]]]));

            const result = await transitionStart(
                'Modifying',
                'ArrangingAdditionalPayment',
                createReadyOrder(),
            );

            expect(result).toBe('message.cannot-transition-no-additional-payments-needed');
        });

        it('allows Modifying -> ArrangingAdditionalPayment when a modification is unsettled', async () => {
            const modification = new OrderModification({ priceChange: 100 });
            await setup({}, new Map([[OrderModification, [modification]]]));

            const result = await transitionStart(
                'Modifying',
                'ArrangingAdditionalPayment',
                createReadyOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('skips the modification check when checkModificationPayments is false', async () => {
            const modification = new OrderModification({ priceChange: 100 });
            await setup({ checkModificationPayments: false }, new Map([[OrderModification, [modification]]]));
            const order = createReadyOrder();
            order.payments = [new Payment({ state: 'Settled', amount: 0 })];

            const result = await transitionStart('Modifying', 'PaymentSettled', order);

            expect(result).toBeUndefined();
            expect(mocks.find).not.toHaveBeenCalledWith(OrderModification, expect.anything());
        });
    });

    describe('onTransitionStart: ArrangingAdditionalPayment', () => {
        it('blocks leaving when payments do not cover the total', async () => {
            const payments = [new Payment({ state: 'Settled', amount: 50 })];
            await setup({}, new Map([[Payment, payments]]));
            const order = createReadyOrder();
            order.subTotalWithTax = 100;

            const result = await transitionStart('ArrangingAdditionalPayment', 'PaymentSettled', order);

            expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
            expect(order.payments).toBe(payments);
        });

        it('allows leaving when payments cover the total', async () => {
            const payments = [new Payment({ state: 'Settled', amount: 100 })];
            await setup({}, new Map([[Payment, payments]]));
            const order = createReadyOrder();
            order.subTotalWithTax = 100;

            const result = await transitionStart('ArrangingAdditionalPayment', 'PaymentSettled', order);

            expect(result).toBeUndefined();
        });

        it('never blocks a cancellation', async () => {
            await setup({}, new Map([[Payment, []]]));
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.lines[0].quantity = 0;

            const result = await transitionStart('ArrangingAdditionalPayment', 'Cancelled', order);

            expect(result).toBeUndefined();
            expect(mocks.find).not.toHaveBeenCalled();
        });

        it('skips the check when checkAdditionalPaymentsAmount is false', async () => {
            await setup({ checkAdditionalPaymentsAmount: false }, new Map([[Payment, []]]));
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [new Payment({ state: 'Settled', amount: 100 })];

            const result = await transitionStart('ArrangingAdditionalPayment', 'PaymentSettled', order);

            expect(result).toBeUndefined();
            expect(mocks.find).not.toHaveBeenCalled();
        });
    });

    describe('onTransitionStart: ArrangingPayment', () => {
        it('blocks an empty order', async () => {
            await setup();
            const order = createReadyOrder();
            order.lines = [];

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBe(
                'message.cannot-transition-to-payment-when-order-is-empty',
            );
        });

        it('allows an empty order when arrangingPaymentRequiresContents is false', async () => {
            await setup({ arrangingPaymentRequiresContents: false });
            const order = createReadyOrder();
            order.lines = [];

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBeUndefined();
        });

        it('blocks an order without a customer', async () => {
            await setup({ checkAllVariantsExist: false });
            const order = createReadyOrder();
            order.customer = undefined as any;

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBe(
                'message.cannot-transition-to-payment-without-customer',
            );
        });

        it('allows an order without a customer when arrangingPaymentRequiresCustomer is false', async () => {
            await setup({ checkAllVariantsExist: false, arrangingPaymentRequiresCustomer: false });
            const order = createReadyOrder();
            order.customer = undefined as any;

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBeUndefined();
        });

        it('blocks an order without a shipping method', async () => {
            await setup({ checkAllVariantsExist: false });
            const order = createReadyOrder();
            order.shippingLines = [];

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBe(
                'message.cannot-transition-to-payment-without-shipping-method',
            );
        });

        it('allows an order without a shipping method when arrangingPaymentRequiresShipping is false', async () => {
            await setup({ checkAllVariantsExist: false, arrangingPaymentRequiresShipping: false });
            const order = createReadyOrder();
            order.shippingLines = [];

            expect(await transitionStart('AddingItems', 'ArrangingPayment', order)).toBeUndefined();
        });

        it('blocks when saleable stock is insufficient, naming the variants', async () => {
            await setup({ checkAllVariantsExist: false });
            const order = createReadyOrder();
            const translate = vi.spyOn(ctx, 'translate');
            productVariantService.getSaleableStockLevel.mockResolvedValue(1);

            const result = await transitionStart('AddingItems', 'ArrangingPayment', order);

            expect(result).toBe('message.cannot-transition-to-payment-due-to-insufficient-stock');
            expect(translate).toHaveBeenCalledWith(
                'message.cannot-transition-to-payment-due-to-insufficient-stock',
                { productVariantNames: 'Variant A' },
            );
            expect(productVariantService.getSaleableStockLevel).toHaveBeenCalledWith(
                ctx,
                order.lines[0].productVariant,
            );
            translate.mockRestore();
        });

        it('allows when saleable stock exactly matches the quantity', async () => {
            await setup({ checkAllVariantsExist: false });
            productVariantService.getSaleableStockLevel.mockResolvedValue(2);

            expect(
                await transitionStart('AddingItems', 'ArrangingPayment', createReadyOrder()),
            ).toBeUndefined();
        });

        it('skips the stock check when arrangingPaymentRequiresStock is false', async () => {
            await setup({ checkAllVariantsExist: false, arrangingPaymentRequiresStock: false });
            productVariantService.getSaleableStockLevel.mockResolvedValue(0);

            expect(
                await transitionStart('AddingItems', 'ArrangingPayment', createReadyOrder()),
            ).toBeUndefined();
            expect(productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
        });

        it('does not query variants when transitioning from Draft', async () => {
            await setup();
            const order = createReadyOrder();

            expect(await transitionStart('Draft', 'ArrangingPayment', order)).toBeUndefined();
        });
    });

    describe('onTransitionStart: payments', () => {
        it('blocks PaymentAuthorized without an authorized payment covering the total', async () => {
            await setup();
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [new Payment({ state: 'Authorized', amount: 50 })];

            expect(await transitionStart('ArrangingPayment', 'PaymentAuthorized', order)).toBe(
                'message.cannot-transition-without-authorized-payments',
            );
        });

        it('blocks PaymentAuthorized when the total is covered only by settled payments', async () => {
            await setup();
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [new Payment({ state: 'Settled', amount: 100 })];

            expect(await transitionStart('ArrangingPayment', 'PaymentAuthorized', order)).toBe(
                'message.cannot-transition-without-authorized-payments',
            );
        });

        it('allows PaymentAuthorized when authorized + settled payments cover the total', async () => {
            await setup();
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [
                new Payment({ state: 'Authorized', amount: 40 }),
                new Payment({ state: 'Settled', amount: 60 }),
            ];

            expect(await transitionStart('ArrangingPayment', 'PaymentAuthorized', order)).toBeUndefined();
        });

        it('blocks PaymentSettled when settled payments do not cover the total', async () => {
            await setup();
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [new Payment({ state: 'Authorized', amount: 100 })];

            expect(await transitionStart('ArrangingPayment', 'PaymentSettled', order)).toBe(
                'message.cannot-transition-without-settled-payments',
            );
        });

        it('allows PaymentSettled when settled payments cover the total', async () => {
            await setup();
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [new Payment({ state: 'Settled', amount: 100 })];

            expect(await transitionStart('ArrangingPayment', 'PaymentSettled', order)).toBeUndefined();
        });

        it('skips payment checks when checkPaymentsCoverTotal is false', async () => {
            await setup({ checkPaymentsCoverTotal: false });
            const order = createReadyOrder();
            order.subTotalWithTax = 100;
            order.payments = [];

            expect(await transitionStart('ArrangingPayment', 'PaymentSettled', order)).toBeUndefined();
            expect(await transitionStart('ArrangingPayment', 'PaymentAuthorized', order)).toBeUndefined();
        });
    });

    describe('onTransitionStart: Cancelled', () => {
        it('blocks cancellation of a placed order with uncancelled lines', async () => {
            await setup();

            expect(await transitionStart('PaymentSettled', 'Cancelled', createReadyOrder())).toBe(
                'message.cannot-transition-unless-all-cancelled',
            );
        });

        it('allows cancellation of a placed order once all lines are cancelled', async () => {
            await setup();
            const order = createReadyOrder();
            order.lines[0].quantity = 0;

            expect(await transitionStart('PaymentSettled', 'Cancelled', order)).toBeUndefined();
        });

        it('allows cancellation from AddingItems and ArrangingPayment regardless of lines', async () => {
            await setup();

            expect(await transitionStart('AddingItems', 'Cancelled', createReadyOrder())).toBeUndefined();
            expect(
                await transitionStart('ArrangingPayment', 'Cancelled', createReadyOrder()),
            ).toBeUndefined();
        });

        it('skips the check when checkAllItemsBeforeCancel is false', async () => {
            await setup({ checkAllItemsBeforeCancel: false });

            expect(await transitionStart('PaymentSettled', 'Cancelled', createReadyOrder())).toBeUndefined();
        });
    });

    describe('onTransitionStart: fulfillment states', () => {
        function orderWithFulfillments(config: Array<{ state: string; quantity: number }>): Order {
            const order = createReadyOrder();
            order.fulfillments = config.map(({ state, quantity }, i) => {
                const fulfillment = new Fulfillment({ id: i + 1, state: state as any });
                fulfillment.lines = [
                    new FulfillmentLine({
                        orderLineId: 1,
                        quantity,
                        fulfillment,
                        fulfillmentId: fulfillment.id,
                    }),
                ];
                return fulfillment;
            });
            return order;
        }

        it('blocks Shipped unless every item is in a Shipped fulfillment', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Shipped', quantity: 1 }]),
            );

            const result = await transitionStart('PaymentSettled', 'Shipped', createReadyOrder());

            expect(result).toBe('message.cannot-transition-unless-all-order-items-shipped');
            expect(mocks.getEntityOrThrow).toHaveBeenCalledWith(
                ctx,
                Order,
                1,
                expect.objectContaining({ relations: expect.arrayContaining(['fulfillments.lines']) }),
            );
        });

        it('allows Shipped when every item is in a Shipped fulfillment', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Shipped', quantity: 2 }]),
            );

            expect(await transitionStart('PaymentSettled', 'Shipped', createReadyOrder())).toBeUndefined();
        });

        it('blocks PartiallyShipped when no items are shipped', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(orderWithFulfillments([]));

            expect(await transitionStart('PaymentSettled', 'PartiallyShipped', createReadyOrder())).toBe(
                'message.cannot-transition-unless-some-order-items-shipped',
            );
        });

        it('allows PartiallyShipped when only some items are shipped', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Shipped', quantity: 1 }]),
            );

            expect(
                await transitionStart('PaymentSettled', 'PartiallyShipped', createReadyOrder()),
            ).toBeUndefined();
        });

        it('blocks Delivered unless every item is in a Delivered fulfillment', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Shipped', quantity: 2 }]),
            );

            expect(await transitionStart('Shipped', 'Delivered', createReadyOrder())).toBe(
                'message.cannot-transition-unless-all-order-items-delivered',
            );
        });

        it('allows Delivered when every item is in a Delivered fulfillment', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Delivered', quantity: 2 }]),
            );

            expect(await transitionStart('Shipped', 'Delivered', createReadyOrder())).toBeUndefined();
        });

        it('blocks PartiallyDelivered when no items are delivered', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([{ state: 'Shipped', quantity: 2 }]),
            );

            expect(await transitionStart('Shipped', 'PartiallyDelivered', createReadyOrder())).toBe(
                'message.cannot-transition-unless-some-order-items-delivered',
            );
        });

        it('allows PartiallyDelivered when only some items are delivered', async () => {
            await setup();
            mocks.getEntityOrThrow.mockResolvedValue(
                orderWithFulfillments([
                    { state: 'Delivered', quantity: 1 },
                    { state: 'Shipped', quantity: 1 },
                ]),
            );

            expect(
                await transitionStart('Shipped', 'PartiallyDelivered', createReadyOrder()),
            ).toBeUndefined();
        });

        it('skips fulfillment checks when checkFulfillmentStates is false', async () => {
            await setup({ checkFulfillmentStates: false });

            expect(await transitionStart('PaymentSettled', 'Shipped', createReadyOrder())).toBeUndefined();
            expect(mocks.getEntityOrThrow).not.toHaveBeenCalled();
        });
    });

    describe('onTransitionEnd', () => {
        it('always records a state transition history entry', async () => {
            await setup();
            const order = createReadyOrder();

            await transitionEnd('AddingItems', 'ArrangingPayment', order);

            expect(historyService.createHistoryEntryForOrder).toHaveBeenCalledWith({
                orderId: 1,
                type: HistoryEntryType.ORDER_STATE_TRANSITION,
                ctx,
                data: { from: 'AddingItems', to: 'ArrangingPayment' },
            });
        });

        it('places the order when the OrderPlacedStrategy says so', async () => {
            await setup();
            orderPlacedStrategy.shouldSetAsPlaced.mockReturnValue(true);
            const order = createReadyOrder();
            order.active = true;

            await transitionEnd('ArrangingPayment', 'PaymentSettled', order);

            expect(orderPlacedStrategy.shouldSetAsPlaced).toHaveBeenCalledWith(
                ctx,
                'ArrangingPayment',
                'PaymentSettled',
                order,
            );
            expect(order.active).toBe(false);
            expect(order.orderPlacedAt).toBeInstanceOf(Date);
            expect(order.lines[0].orderPlacedQuantity).toBe(2);
            expect(mocks.update).toHaveBeenCalledWith(1, { orderPlacedQuantity: 2 });
            const event = eventBus.publish.mock.calls[0][0];
            expect(event).toBeInstanceOf(OrderPlacedEvent);
            expect(event.fromState).toBe('ArrangingPayment');
            expect(event.toState).toBe('PaymentSettled');
            expect(event.order).toBe(order);
            expect(orderSplitter.createSellerOrders).toHaveBeenCalledWith(ctx, order);
        });

        it('does not place the order when the strategy declines', async () => {
            await setup();
            const order = createReadyOrder();
            order.active = true;

            await transitionEnd('AddingItems', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
            expect(order.orderPlacedAt).toBeUndefined();
            expect(eventBus.publish).not.toHaveBeenCalled();
            expect(orderSplitter.createSellerOrders).not.toHaveBeenCalled();
        });

        it('does not consult the OrderPlacedStrategy for an inactive order', async () => {
            await setup();
            orderPlacedStrategy.shouldSetAsPlaced.mockReturnValue(true);
            const order = createReadyOrder();
            order.active = false;

            await transitionEnd('PaymentSettled', 'Shipped', order);

            expect(orderPlacedStrategy.shouldSetAsPlaced).not.toHaveBeenCalled();
            expect(eventBus.publish).not.toHaveBeenCalled();
        });

        it('allocates stock when the StockAllocationStrategy says so', async () => {
            await setup();
            stockAllocationStrategy.shouldAllocateStock.mockResolvedValue(true);
            const order = createReadyOrder();

            await transitionEnd('ArrangingPayment', 'PaymentSettled', order);

            expect(stockAllocationStrategy.shouldAllocateStock).toHaveBeenCalledWith(
                ctx,
                'ArrangingPayment',
                'PaymentSettled',
                order,
            );
            expect(stockMovementService.createAllocationsForOrder).toHaveBeenCalledWith(ctx, order);
        });

        it('does not allocate stock when the strategy declines', async () => {
            await setup();

            await transitionEnd('ArrangingPayment', 'PaymentSettled', createReadyOrder());

            expect(stockMovementService.createAllocationsForOrder).not.toHaveBeenCalled();
        });

        it('deactivates the order on cancellation', async () => {
            await setup();
            const order = createReadyOrder();
            order.active = true;

            await transitionEnd('AddingItems', 'Cancelled', order);

            expect(order.active).toBe(false);
        });

        it('activates a Draft order once it moves to ArrangingPayment', async () => {
            await setup();
            const order = createReadyOrder();
            order.active = false;

            await transitionEnd('Draft', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
        });
    });
});
