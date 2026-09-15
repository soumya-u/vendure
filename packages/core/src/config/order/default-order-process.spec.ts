import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../api/common/request-context';
import { Injector } from '../../common/injector';
import { Customer } from '../../entity/customer/customer.entity';
import { Fulfillment } from '../../entity/fulfillment/fulfillment.entity';
import { FulfillmentLine } from '../../entity/order-line-reference/fulfillment-line.entity';
import { OrderLine } from '../../entity/order-line/order-line.entity';
import { OrderModification } from '../../entity/order-modification/order-modification.entity';
import { Order } from '../../entity/order/order.entity';
import { Payment } from '../../entity/payment/payment.entity';
import { ProductVariant } from '../../entity/product-variant/product-variant.entity';
import { Refund } from '../../entity/refund/refund.entity';
import { ShippingLine } from '../../entity/shipping-line/shipping-line.entity';
import { OrderPlacedEvent } from '../../event-bus/events/order-placed-event';
import { OrderState } from '../../service/helpers/order-state-machine/order-state';
import { createOrderFromLines } from '../../testing/order-test-utils';

import { configureDefaultOrderProcess, DefaultOrderProcessOptions } from './default-order-process';

/**
 * The process resolves its collaborators from the Injector by class token inside `init()`. The
 * tokens are lazily imported there, so the fake Injector matches on the class name rather than on
 * identity, which keeps this spec from having to import the whole service barrel.
 */
function createMocks() {
    const repositories: Record<string, any> = {};
    const connection = {
        getRepository: vi.fn((ctx: RequestContext, entity: { name: string }) => repositories[entity.name]),
        getEntityOrThrow: vi.fn(),
    };
    const productVariantService = { getSaleableStockLevel: vi.fn().mockResolvedValue(100) };
    const configService = {
        orderOptions: {
            orderPlacedStrategy: { shouldSetAsPlaced: vi.fn().mockReturnValue(false) },
            stockAllocationStrategy: { shouldAllocateStock: vi.fn().mockResolvedValue(false) },
        },
    };
    const eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
    const stockMovementService = { createAllocationsForOrder: vi.fn().mockResolvedValue([]) };
    const stockLevelService = {};
    const historyService = { createHistoryEntryForOrder: vi.fn().mockResolvedValue(undefined) };
    const orderSplitter = { createSellerOrders: vi.fn().mockResolvedValue([]) };
    const byName: Record<string, any> = {
        TransactionalConnection: connection,
        ProductVariantService: productVariantService,
        ConfigService: configService,
        EventBus: eventBus,
        StockMovementService: stockMovementService,
        StockLevelService: stockLevelService,
        HistoryService: historyService,
        OrderSplitter: orderSplitter,
    };
    const injector = {
        get: (token: { name: string }) => byName[token.name],
    } as unknown as Injector;
    return {
        repositories,
        connection,
        productVariantService,
        configService,
        eventBus,
        stockMovementService,
        historyService,
        orderSplitter,
        injector,
    };
}

async function createProcess(options: DefaultOrderProcessOptions = {}) {
    const mocks = createMocks();
    const process = configureDefaultOrderProcess({ checkAllVariantsExist: false, ...options });
    await process.init?.(mocks.injector);
    return { process, ...mocks };
}

function createCheckoutReadyOrder(): Order {
    const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
    order.id = 1;
    order.customer = new Customer({ id: 5 });
    order.shippingLines = [new ShippingLine({ id: 1 })];
    order.lines[0].productVariant.name = 'Variant A';
    return order;
}

function createOrderWithFulfillments(
    lines: Array<{ lineId: number; quantity: number }>,
    fulfillments: Array<{ state: string; lines: Array<{ lineId: number; quantity: number }> }>,
): Order {
    const order = new Order({
        id: 1,
        lines: lines.map(l => new OrderLine({ id: l.lineId, quantity: l.quantity })),
        fulfillments: fulfillments.map(
            f =>
                new Fulfillment({
                    state: f.state as any,
                    lines: f.lines.map(fl => {
                        const line = new FulfillmentLine({ orderLineId: fl.lineId, quantity: fl.quantity });
                        line.fulfillment = { state: f.state } as Fulfillment;
                        return line;
                    }),
                }),
        ),
    });
    return order;
}

describe('configureDefaultOrderProcess()', () => {
    const ctx = RequestContext.empty();

    describe('transitions', () => {
        it('defines a terminal Cancelled state', () => {
            const process = configureDefaultOrderProcess({});
            expect(process.transitions?.Cancelled.to).toEqual([]);
        });

        it('allows the Draft -> ArrangingPayment path used by draft orders', () => {
            const process = configureDefaultOrderProcess({});
            expect(process.transitions?.Draft.to).toContain('ArrangingPayment');
            expect(process.transitions?.Created.to).toEqual(['AddingItems', 'Draft']);
        });
    });

    describe('onTransitionStart()', () => {
        let mocks: Awaited<ReturnType<typeof createProcess>>;

        function transition(from: OrderState, to: OrderState, order: Order) {
            return mocks.process.onTransitionStart?.(from, to, { ctx, order });
        }

        describe('leaving Modifying', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            function stubModifications(modifications: OrderModification[]) {
                mocks.repositories.OrderModification = { find: vi.fn().mockResolvedValue(modifications) };
            }

            it('blocks ArrangingAdditionalPayment when every modification is already settled', async () => {
                stubModifications([new OrderModification({ priceChange: 0 })]);
                const order = new Order({ id: 1, lines: [] });

                const result = await transition('Modifying', 'ArrangingAdditionalPayment', order);

                expect(result).toBe('message.cannot-transition-no-additional-payments-needed');
            });

            it('allows ArrangingAdditionalPayment when a modification is unsettled', async () => {
                stubModifications([new OrderModification({ priceChange: 500 })]);
                const order = new Order({ id: 1, lines: [] });

                const result = await transition('Modifying', 'ArrangingAdditionalPayment', order);

                expect(result).toBeUndefined();
            });

            it('allows ArrangingAdditionalPayment when there are no modifications', async () => {
                stubModifications([]);
                const order = new Order({ id: 1, lines: [] });

                const result = await transition('Modifying', 'ArrangingAdditionalPayment', order);

                expect(result).toBeUndefined();
            });

            it('blocks any other state when a modification is unsettled', async () => {
                stubModifications([new OrderModification({ priceChange: -500 })]);
                const order = new Order({ id: 1, lines: [], payments: [] });

                const result = await transition('Modifying', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-without-modification-payment');
            });

            it('treats a modification with a refund as settled', async () => {
                stubModifications([new OrderModification({ priceChange: -500, refund: new Refund({}) })]);
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    payments: [new Payment({ state: 'Settled', amount: 500 })],
                });

                const result = await transition('Modifying', 'PaymentSettled', order);

                expect(result).toBeUndefined();
            });

            it('queries modifications scoped to the order with refund and payment relations', async () => {
                stubModifications([]);
                const order = new Order({ id: 42, lines: [], payments: [] });

                await transition('Modifying', 'PaymentSettled', order);

                expect(mocks.repositories.OrderModification.find).toHaveBeenCalledWith({
                    where: { order: { id: 42 } },
                    relations: ['refund', 'payment'],
                });
            });

            it('skips the check when checkModificationPayments is false', async () => {
                mocks = await createProcess({ checkModificationPayments: false });
                const order = new Order({ id: 1, lines: [] });

                const result = await transition('Modifying', 'ArrangingAdditionalPayment', order);

                expect(result).toBeUndefined();
                expect(mocks.connection.getRepository).not.toHaveBeenCalled();
            });
        });

        describe('leaving ArrangingAdditionalPayment', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            function stubPayments(payments: Payment[]) {
                mocks.repositories.Payment = { find: vi.fn().mockResolvedValue(payments) };
            }

            it('blocks when payments do not cover the total', async () => {
                stubPayments([new Payment({ state: 'Settled', amount: 400 })]);
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 1000, shippingWithTax: 0 });

                const result = await transition('ArrangingAdditionalPayment', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
            });

            it('allows when payments cover the total and attaches them to the order', async () => {
                const payments = [
                    new Payment({ state: 'Settled', amount: 600 }),
                    new Payment({ state: 'Settled', amount: 400 }),
                ];
                stubPayments(payments);
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 1000, shippingWithTax: 0 });

                const result = await transition('ArrangingAdditionalPayment', 'PaymentSettled', order);

                expect(result).toBeUndefined();
                expect(order.payments).toBe(payments);
            });

            it('subtracts settled refunds from the covered amount', async () => {
                stubPayments([
                    new Payment({
                        state: 'Settled',
                        amount: 1000,
                        refunds: [new Refund({ state: 'Settled', total: 100 })],
                    }),
                ]);
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 1000, shippingWithTax: 0 });

                const result = await transition('ArrangingAdditionalPayment', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
            });

            it('does not check payments when cancelling', async () => {
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 1000 });

                const result = await transition('ArrangingAdditionalPayment', 'Cancelled', order);

                expect(result).toBeUndefined();
                expect(mocks.connection.getRepository).not.toHaveBeenCalled();
            });

            it('skips the check when checkAdditionalPaymentsAmount is false', async () => {
                mocks = await createProcess({
                    checkAdditionalPaymentsAmount: false,
                    checkPaymentsCoverTotal: false,
                });
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 1000, payments: [] });

                const result = await transition('ArrangingAdditionalPayment', 'PaymentSettled', order);

                expect(result).toBeUndefined();
                expect(mocks.connection.getRepository).not.toHaveBeenCalled();
            });
        });

        describe('entering ArrangingPayment', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            it('blocks an empty order', async () => {
                const order = createCheckoutReadyOrder();
                order.lines = [];

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-when-order-is-empty');
            });

            it('allows an empty order when arrangingPaymentRequiresContents is false', async () => {
                mocks = await createProcess({ arrangingPaymentRequiresContents: false });
                const order = createCheckoutReadyOrder();
                order.lines = [];

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('blocks an order without a customer', async () => {
                const order = createCheckoutReadyOrder();
                order.customer = undefined as any;

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-customer');
            });

            it('allows an order without a customer when arrangingPaymentRequiresCustomer is false', async () => {
                mocks = await createProcess({ arrangingPaymentRequiresCustomer: false });
                const order = createCheckoutReadyOrder();
                order.customer = undefined as any;

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('blocks an order without shipping lines', async () => {
                const order = createCheckoutReadyOrder();
                order.shippingLines = [];

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-shipping-method');
            });

            it('blocks an order whose shippingLines relation is not loaded', async () => {
                const order = createCheckoutReadyOrder();
                order.shippingLines = undefined as any;

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-shipping-method');
            });

            it('allows an order without shipping when arrangingPaymentRequiresShipping is false', async () => {
                mocks = await createProcess({ arrangingPaymentRequiresShipping: false });
                const order = createCheckoutReadyOrder();
                order.shippingLines = [];

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('blocks when saleable stock is insufficient, naming the variants', async () => {
                const order = createCheckoutReadyOrder();
                order.lines.push(
                    new OrderLine({
                        id: 2,
                        quantity: 5,
                        productVariant: new ProductVariant({ id: 101, name: 'Variant B' }),
                    }),
                );
                mocks.productVariantService.getSaleableStockLevel.mockResolvedValue(1);
                const translate = vi.spyOn(ctx, 'translate');

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-due-to-insufficient-stock');
                expect(translate).toHaveBeenCalledWith(
                    'message.cannot-transition-to-payment-due-to-insufficient-stock',
                    { productVariantNames: 'Variant A, Variant B' },
                );
                translate.mockRestore();
            });

            it('allows when saleable stock exactly matches the quantity', async () => {
                const order = createCheckoutReadyOrder();
                mocks.productVariantService.getSaleableStockLevel.mockResolvedValue(2);

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
                expect(mocks.productVariantService.getSaleableStockLevel).toHaveBeenCalledWith(
                    ctx,
                    order.lines[0].productVariant,
                );
            });

            it('does not check stock when arrangingPaymentRequiresStock is false', async () => {
                mocks = await createProcess({ arrangingPaymentRequiresStock: false });
                const order = createCheckoutReadyOrder();
                mocks.productVariantService.getSaleableStockLevel.mockResolvedValue(0);

                const result = await transition('AddingItems', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
                expect(mocks.productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
            });
        });

        describe('payment coverage', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            it('blocks PaymentAuthorized when there is no authorized payment', async () => {
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    payments: [new Payment({ state: 'Settled', amount: 500 })],
                });

                const result = await transition('ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBe('message.cannot-transition-without-authorized-payments');
            });

            it('blocks PaymentAuthorized when authorized payments do not cover the total', async () => {
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    payments: [new Payment({ state: 'Authorized', amount: 400 })],
                });

                const result = await transition('ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBe('message.cannot-transition-without-authorized-payments');
            });

            it('allows PaymentAuthorized when authorized plus settled payments cover the total', async () => {
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    payments: [
                        new Payment({ state: 'Authorized', amount: 300 }),
                        new Payment({ state: 'Settled', amount: 200 }),
                    ],
                });

                const result = await transition('ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBeUndefined();
            });

            it('blocks PaymentSettled when only authorized payments exist', async () => {
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    payments: [new Payment({ state: 'Authorized', amount: 500 })],
                });

                const result = await transition('ArrangingPayment', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-without-settled-payments');
            });

            it('allows PaymentSettled when settled payments cover the total including shipping', async () => {
                const order = new Order({
                    id: 1,
                    lines: [],
                    subTotalWithTax: 500,
                    shippingWithTax: 100,
                    payments: [new Payment({ state: 'Settled', amount: 600 })],
                });

                const result = await transition('ArrangingPayment', 'PaymentSettled', order);

                expect(result).toBeUndefined();
            });

            it('skips the check when checkPaymentsCoverTotal is false', async () => {
                mocks = await createProcess({ checkPaymentsCoverTotal: false });
                const order = new Order({ id: 1, lines: [], subTotalWithTax: 500, payments: [] });

                expect(await transition('ArrangingPayment', 'PaymentAuthorized', order)).toBeUndefined();
                expect(await transition('ArrangingPayment', 'PaymentSettled', order)).toBeUndefined();
            });
        });

        describe('cancelling', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            it('blocks Cancelled from a placed state unless all lines are cancelled', async () => {
                const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);

                const result = await transition('PaymentSettled', 'Cancelled', order);

                expect(result).toBe('message.cannot-transition-unless-all-cancelled');
            });

            it('allows Cancelled from a placed state when every line has quantity 0', async () => {
                const order = createOrderFromLines([{ lineId: 1, quantity: 0, productVariantId: 100 }]);

                const result = await transition('PaymentSettled', 'Cancelled', order);

                expect(result).toBeUndefined();
            });

            it('allows Cancelled from AddingItems and ArrangingPayment regardless of line quantities', async () => {
                const order = createOrderFromLines([{ lineId: 1, quantity: 3, productVariantId: 100 }]);

                expect(await transition('AddingItems', 'Cancelled', order)).toBeUndefined();
                expect(await transition('ArrangingPayment', 'Cancelled', order)).toBeUndefined();
            });

            it('skips the check when checkAllItemsBeforeCancel is false', async () => {
                mocks = await createProcess({ checkAllItemsBeforeCancel: false });
                const order = createOrderFromLines([{ lineId: 1, quantity: 3, productVariantId: 100 }]);

                const result = await transition('PaymentSettled', 'Cancelled', order);

                expect(result).toBeUndefined();
            });
        });

        describe('fulfillment states', () => {
            beforeEach(async () => {
                mocks = await createProcess();
            });

            function stubOrderWithFulfillments(order: Order) {
                mocks.connection.getEntityOrThrow.mockResolvedValue(order);
            }

            it('loads the order with its fulfillment relations', async () => {
                stubOrderWithFulfillments(createOrderWithFulfillments([{ lineId: 1, quantity: 1 }], []));
                const order = new Order({ id: 7, lines: [] });

                await transition('PaymentSettled', 'Shipped', order);

                expect(mocks.connection.getEntityOrThrow).toHaveBeenCalledWith(ctx, Order, 7, {
                    relations: [
                        'lines',
                        'fulfillments',
                        'fulfillments.lines',
                        'fulfillments.lines.fulfillment',
                    ],
                });
            });

            it('blocks Shipped when a line is not part of a shipped fulfillment', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [
                            { lineId: 1, quantity: 1 },
                            { lineId: 2, quantity: 1 },
                        ],
                        [{ state: 'Shipped', lines: [{ lineId: 1, quantity: 1 }] }],
                    ),
                );

                const result = await transition('PaymentSettled', 'Shipped', new Order({ id: 1, lines: [] }));

                expect(result).toBe('message.cannot-transition-unless-all-order-items-shipped');
            });

            it('allows Shipped when all lines are in shipped fulfillments', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [{ lineId: 1, quantity: 2 }],
                        [{ state: 'Shipped', lines: [{ lineId: 1, quantity: 2 }] }],
                    ),
                );

                const result = await transition('PaymentSettled', 'Shipped', new Order({ id: 1, lines: [] }));

                expect(result).toBeUndefined();
            });

            it('blocks PartiallyShipped when nothing is shipped', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [{ lineId: 1, quantity: 2 }],
                        [{ state: 'Pending', lines: [{ lineId: 1, quantity: 2 }] }],
                    ),
                );

                const result = await transition(
                    'PaymentSettled',
                    'PartiallyShipped',
                    new Order({ id: 1, lines: [] }),
                );

                expect(result).toBe('message.cannot-transition-unless-some-order-items-shipped');
            });

            it('allows PartiallyShipped when only some lines are shipped', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [
                            { lineId: 1, quantity: 1 },
                            { lineId: 2, quantity: 1 },
                        ],
                        [{ state: 'Shipped', lines: [{ lineId: 1, quantity: 1 }] }],
                    ),
                );

                const result = await transition(
                    'PaymentSettled',
                    'PartiallyShipped',
                    new Order({ id: 1, lines: [] }),
                );

                expect(result).toBeUndefined();
            });

            it('blocks Delivered when a fulfillment is only shipped', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [{ lineId: 1, quantity: 2 }],
                        [{ state: 'Shipped', lines: [{ lineId: 1, quantity: 2 }] }],
                    ),
                );

                const result = await transition('Shipped', 'Delivered', new Order({ id: 1, lines: [] }));

                expect(result).toBe('message.cannot-transition-unless-all-order-items-delivered');
            });

            it('allows Delivered when all lines are delivered', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [{ lineId: 1, quantity: 2 }],
                        [{ state: 'Delivered', lines: [{ lineId: 1, quantity: 2 }] }],
                    ),
                );

                const result = await transition('Shipped', 'Delivered', new Order({ id: 1, lines: [] }));

                expect(result).toBeUndefined();
            });

            it('blocks PartiallyDelivered when nothing is delivered', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [{ lineId: 1, quantity: 2 }],
                        [{ state: 'Shipped', lines: [{ lineId: 1, quantity: 2 }] }],
                    ),
                );

                const result = await transition(
                    'Shipped',
                    'PartiallyDelivered',
                    new Order({ id: 1, lines: [] }),
                );

                expect(result).toBe('message.cannot-transition-unless-some-order-items-delivered');
            });

            it('allows PartiallyDelivered when one of two fulfillments is delivered', async () => {
                stubOrderWithFulfillments(
                    createOrderWithFulfillments(
                        [
                            { lineId: 1, quantity: 1 },
                            { lineId: 2, quantity: 1 },
                        ],
                        [
                            { state: 'Delivered', lines: [{ lineId: 1, quantity: 1 }] },
                            { state: 'Shipped', lines: [{ lineId: 2, quantity: 1 }] },
                        ],
                    ),
                );

                const result = await transition(
                    'Shipped',
                    'PartiallyDelivered',
                    new Order({ id: 1, lines: [] }),
                );

                expect(result).toBeUndefined();
            });

            it('skips the check when checkFulfillmentStates is false', async () => {
                mocks = await createProcess({ checkFulfillmentStates: false });

                const result = await transition('PaymentSettled', 'Shipped', new Order({ id: 1, lines: [] }));

                expect(result).toBeUndefined();
                expect(mocks.connection.getEntityOrThrow).not.toHaveBeenCalled();
            });
        });
    });

    describe('onTransitionEnd()', () => {
        let mocks: Awaited<ReturnType<typeof createProcess>>;

        function transitionEnd(from: OrderState, to: OrderState, order: Order) {
            return mocks.process.onTransitionEnd?.(from, to, { ctx, order });
        }

        beforeEach(async () => {
            mocks = await createProcess();
            mocks.repositories.OrderLine = { update: vi.fn().mockResolvedValue(undefined) };
        });

        it('always records a state transition history entry', async () => {
            const order = new Order({ id: 3, active: false, lines: [] });

            await transitionEnd('PaymentSettled', 'Shipped', order);

            expect(mocks.historyService.createHistoryEntryForOrder).toHaveBeenCalledWith({
                orderId: 3,
                type: HistoryEntryType.ORDER_STATE_TRANSITION,
                ctx,
                data: { from: 'PaymentSettled', to: 'Shipped' },
            });
        });

        it('places the order when the OrderPlacedStrategy says so', async () => {
            mocks.configService.orderOptions.orderPlacedStrategy.shouldSetAsPlaced.mockReturnValue(true);
            const order = createOrderFromLines([
                { lineId: 1, quantity: 2, productVariantId: 100 },
                { lineId: 2, quantity: 3, productVariantId: 101 },
            ]);
            order.id = 1;
            order.active = true;

            await transitionEnd('ArrangingPayment', 'PaymentSettled', order);

            expect(order.active).toBe(false);
            expect(order.orderPlacedAt).toBeInstanceOf(Date);
            expect(order.lines.map(l => l.orderPlacedQuantity)).toEqual([2, 3]);
            expect(mocks.repositories.OrderLine.update).toHaveBeenCalledWith(1, { orderPlacedQuantity: 2 });
            expect(mocks.repositories.OrderLine.update).toHaveBeenCalledWith(2, { orderPlacedQuantity: 3 });
            expect(mocks.eventBus.publish).toHaveBeenCalledWith(expect.any(OrderPlacedEvent));
            const event = mocks.eventBus.publish.mock.calls[0][0] as OrderPlacedEvent;
            expect(event.fromState).toBe('ArrangingPayment');
            expect(event.toState).toBe('PaymentSettled');
            expect(event.order).toBe(order);
            expect(mocks.orderSplitter.createSellerOrders).toHaveBeenCalledWith(ctx, order);
        });

        it('does not place the order when the strategy returns false', async () => {
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 100 }]);
            order.active = true;

            await transitionEnd('AddingItems', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
            expect(order.orderPlacedAt).toBeUndefined();
            expect(mocks.eventBus.publish).not.toHaveBeenCalled();
            expect(mocks.orderSplitter.createSellerOrders).not.toHaveBeenCalled();
        });

        it('does not consult the OrderPlacedStrategy for an inactive order', async () => {
            const order = new Order({ id: 1, active: false, lines: [] });

            await transitionEnd('PaymentSettled', 'Shipped', order);

            expect(
                mocks.configService.orderOptions.orderPlacedStrategy.shouldSetAsPlaced,
            ).not.toHaveBeenCalled();
        });

        it('allocates stock when the StockAllocationStrategy says so', async () => {
            mocks.configService.orderOptions.stockAllocationStrategy.shouldAllocateStock.mockResolvedValue(
                true,
            );
            const order = new Order({ id: 1, active: false, lines: [] });

            await transitionEnd('ArrangingPayment', 'PaymentSettled', order);

            expect(
                mocks.configService.orderOptions.stockAllocationStrategy.shouldAllocateStock,
            ).toHaveBeenCalledWith(ctx, 'ArrangingPayment', 'PaymentSettled', order);
            expect(mocks.stockMovementService.createAllocationsForOrder).toHaveBeenCalledWith(ctx, order);
        });

        it('does not allocate stock when the strategy returns false', async () => {
            const order = new Order({ id: 1, active: false, lines: [] });

            await transitionEnd('ArrangingPayment', 'PaymentSettled', order);

            expect(mocks.stockMovementService.createAllocationsForOrder).not.toHaveBeenCalled();
        });

        it('deactivates the order on Cancelled', async () => {
            const order = new Order({ id: 1, active: true, lines: [] });

            await transitionEnd('AddingItems', 'Cancelled', order);

            expect(order.active).toBe(false);
        });

        it('activates a draft order once it moves to ArrangingPayment', async () => {
            const order = new Order({ id: 1, active: false, lines: [] });

            await transitionEnd('Draft', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
        });

        it('leaves active untouched for other transitions', async () => {
            const order = new Order({ id: 1, active: false, lines: [] });

            await transitionEnd('PaymentSettled', 'Shipped', order);

            expect(order.active).toBe(false);
        });
    });
});
