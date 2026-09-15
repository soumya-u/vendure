import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../api/common/request-context';
import { Injector } from '../../common/injector';
import { LocaleString } from '../../common/types/locale-types';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Fulfillment } from '../../entity/fulfillment/fulfillment.entity';
import { FulfillmentLine } from '../../entity/order-line-reference/fulfillment-line.entity';
import { OrderLine } from '../../entity/order-line/order-line.entity';
import { OrderModification } from '../../entity/order-modification/order-modification.entity';
import { Order } from '../../entity/order/order.entity';
import { Payment } from '../../entity/payment/payment.entity';
import { ProductVariant } from '../../entity/product-variant/product-variant.entity';
import { Refund } from '../../entity/refund/refund.entity';
import { ShippingLine } from '../../entity/shipping-line/shipping-line.entity';
import { EventBus } from '../../event-bus/event-bus';
import { OrderPlacedEvent } from '../../event-bus/events/order-placed-event';
import { FulfillmentState } from '../../service/helpers/fulfillment-state-machine/fulfillment-state';
import { OrderSplitter } from '../../service/helpers/order-splitter/order-splitter';
import { OrderState } from '../../service/helpers/order-state-machine/order-state';
import { HistoryService } from '../../service/services/history.service';
import { ProductVariantService } from '../../service/services/product-variant.service';
import { StockLevelService } from '../../service/services/stock-level.service';
import { StockMovementService } from '../../service/services/stock-movement.service';
import { createOrderFromLines } from '../../testing/order-test-utils';
import { ConfigService } from '../config.service';
import { MockConfigService } from '../config.service.mock';

import { DefaultOrderPlacedStrategy } from './default-order-placed-strategy';
import {
    configureDefaultOrderProcess,
    defaultOrderProcess,
    DefaultOrderProcessOptions,
} from './default-order-process';
import { DefaultStockAllocationStrategy } from './default-stock-allocation-strategy';

type Repos = {
    orderModification?: { find: ReturnType<typeof vi.fn> };
    payment?: { find: ReturnType<typeof vi.fn> };
    orderLine?: { update: ReturnType<typeof vi.fn> };
};

/**
 * Builds a configured default OrderProcess with all of its injected services replaced by
 * mocks. The mocks are returned so that tests can assert on the calls made to them.
 */
async function createProcess(options: DefaultOrderProcessOptions = {}, repos: Repos = {}) {
    const orderModificationRepo = repos.orderModification ?? { find: vi.fn().mockResolvedValue([]) };
    const paymentRepo = repos.payment ?? { find: vi.fn().mockResolvedValue([]) };
    const orderLineRepo = repos.orderLine ?? { update: vi.fn().mockResolvedValue(undefined) };
    const getEntityOrThrow = vi.fn();
    const connection = {
        getRepository: vi.fn((ctx: RequestContext, entity: any) => {
            switch (entity) {
                case OrderModification:
                    return orderModificationRepo;
                case Payment:
                    return paymentRepo;
                case OrderLine:
                    return orderLineRepo;
                default:
                    throw new Error(`Unexpected repository requested: ${String(entity?.name)}`);
            }
        }),
        getEntityOrThrow,
    };
    const productVariantService = { getSaleableStockLevel: vi.fn().mockResolvedValue(100) };
    const configService = new MockConfigService();
    configService.orderOptions = {
        orderPlacedStrategy: new DefaultOrderPlacedStrategy(),
        stockAllocationStrategy: new DefaultStockAllocationStrategy(),
    };
    const eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
    const stockMovementService = { createAllocationsForOrder: vi.fn().mockResolvedValue([]) };
    const stockLevelService = {};
    const historyService = { createHistoryEntryForOrder: vi.fn().mockResolvedValue(undefined) };
    const orderSplitter = { createSellerOrders: vi.fn().mockResolvedValue([]) };

    const providers = new Map<any, any>([
        [TransactionalConnection, connection],
        [ProductVariantService, productVariantService],
        [ConfigService, configService],
        [EventBus, eventBus],
        [StockMovementService, stockMovementService],
        [StockLevelService, stockLevelService],
        [HistoryService, historyService],
        [OrderSplitter, orderSplitter],
    ]);
    const injector = {
        get: (token: any) => {
            if (!providers.has(token)) {
                throw new Error(`No mock registered for ${String(token?.name ?? token)}`);
            }
            return providers.get(token);
        },
    } as unknown as Injector;

    const process = configureDefaultOrderProcess(options);
    await process.init?.(injector);
    return {
        process,
        connection,
        orderModificationRepo,
        paymentRepo,
        orderLineRepo,
        getEntityOrThrow,
        productVariantService,
        configService,
        eventBus,
        stockMovementService,
        historyService,
        orderSplitter,
    };
}

function transitionStart(
    process: Awaited<ReturnType<typeof createProcess>>['process'],
    from: OrderState,
    to: OrderState,
    order: Order,
    ctx = RequestContext.empty(),
) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return process.onTransitionStart!(from, to, { ctx, order });
}

function transitionEnd(
    process: Awaited<ReturnType<typeof createProcess>>['process'],
    from: OrderState,
    to: OrderState,
    order: Order,
    ctx = RequestContext.empty(),
) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return process.onTransitionEnd!(from, to, { ctx, order });
}

function orderWithFulfillments(
    lineQuantities: number[],
    fulfillments: Array<{ state: FulfillmentState; lines: Array<{ lineIndex: number; quantity: number }> }>,
): Order {
    const lines = lineQuantities.map((quantity, i) => new OrderLine({ id: i + 1, quantity }));
    const fulfillmentEntities = fulfillments.map(f => {
        const fulfillment = new Fulfillment({ state: f.state, lines: [] });
        fulfillment.lines = f.lines.map(
            l =>
                new FulfillmentLine({
                    orderLineId: lines[l.lineIndex].id,
                    quantity: l.quantity,
                    fulfillment,
                }),
        );
        return fulfillment;
    });
    return new Order({ id: 1, lines, fulfillments: fulfillmentEntities });
}

function payingOrder(totalWithTax: number, payments: Payment[]): Order {
    const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 1 }]);
    order.id = 1;
    order.payments = payments;
    Object.defineProperty(order, 'totalWithTax', { value: totalWithTax });
    return order;
}

describe('defaultOrderProcess', () => {
    describe('transitions', () => {
        it('defines the built-in states and their allowed targets', () => {
            const transitions = defaultOrderProcess.transitions;
            expect(transitions).toBeDefined();
            expect(transitions?.Created.to).toEqual(['AddingItems', 'Draft']);
            expect(transitions?.AddingItems.to).toEqual(['ArrangingPayment', 'Cancelled']);
            expect(transitions?.PaymentSettled.to).toContain('Modifying');
            expect(transitions?.Cancelled.to).toEqual([]);
        });

        it('configureDefaultOrderProcess() returns a process with hooks', () => {
            const process = configureDefaultOrderProcess({});
            expect(process.transitions).toEqual(defaultOrderProcess.transitions);
            expect(typeof process.init).toBe('function');
            expect(typeof process.onTransitionStart).toBe('function');
            expect(typeof process.onTransitionEnd).toBe('function');
        });
    });

    describe('init()', () => {
        it('throws when a required service cannot be resolved from the Injector', async () => {
            const process = configureDefaultOrderProcess({});
            const injector = {
                get: () => {
                    throw new Error('not found');
                },
            } as unknown as Injector;
            await expect(process.init?.(injector)).rejects.toThrow('not found');
        });
    });

    describe('onTransitionStart()', () => {
        describe('checkModificationPayments', () => {
            it('blocks leaving Modifying when a modification is not settled', async () => {
                const { process, orderModificationRepo } = await createProcess(
                    {},
                    {
                        orderModification: {
                            find: vi.fn().mockResolvedValue([new OrderModification({ priceChange: 500 })]),
                        },
                    },
                );
                const order = payingOrder(1000, []);

                const result = await transitionStart(process, 'Modifying', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-without-modification-payment');
                expect(orderModificationRepo.find).toHaveBeenCalledWith({
                    where: { order: { id: order.id } },
                    relations: ['refund', 'payment'],
                });
            });

            it('allows leaving Modifying when every modification is settled', async () => {
                const settled = new OrderModification({ priceChange: 500, payment: new Payment() });
                const { process } = await createProcess(
                    {},
                    { orderModification: { find: vi.fn().mockResolvedValue([settled]) } },
                );
                const order = payingOrder(0, []);

                const result = await transitionStart(process, 'Modifying', 'PaymentSettled', order);

                expect(result).toBeUndefined();
            });

            it('blocks Modifying -> ArrangingAdditionalPayment when all modifications are settled', async () => {
                const settled = new OrderModification({ priceChange: 0 });
                const { process } = await createProcess(
                    {},
                    { orderModification: { find: vi.fn().mockResolvedValue([settled]) } },
                );

                const result = await transitionStart(
                    process,
                    'Modifying',
                    'ArrangingAdditionalPayment',
                    payingOrder(0, []),
                );

                expect(result).toBe('message.cannot-transition-no-additional-payments-needed');
            });

            it('allows Modifying -> ArrangingAdditionalPayment when a modification is unsettled', async () => {
                const unsettled = new OrderModification({ priceChange: 100 });
                const { process } = await createProcess(
                    {},
                    { orderModification: { find: vi.fn().mockResolvedValue([unsettled]) } },
                );

                const result = await transitionStart(
                    process,
                    'Modifying',
                    'ArrangingAdditionalPayment',
                    payingOrder(0, []),
                );

                expect(result).toBeUndefined();
            });

            it('allows Modifying -> ArrangingAdditionalPayment when there are no modifications', async () => {
                const { process } = await createProcess();

                const result = await transitionStart(
                    process,
                    'Modifying',
                    'ArrangingAdditionalPayment',
                    payingOrder(0, []),
                );

                expect(result).toBeUndefined();
            });

            it('skips the check when checkModificationPayments is false', async () => {
                const unsettled = new OrderModification({ priceChange: 500 });
                const { process, orderModificationRepo } = await createProcess(
                    { checkModificationPayments: false },
                    { orderModification: { find: vi.fn().mockResolvedValue([unsettled]) } },
                );

                const result = await transitionStart(
                    process,
                    'Modifying',
                    'PaymentSettled',
                    payingOrder(0, []),
                );

                expect(result).toBeUndefined();
                expect(orderModificationRepo.find).not.toHaveBeenCalled();
            });
        });

        describe('checkAdditionalPaymentsAmount', () => {
            it('blocks leaving ArrangingAdditionalPayment while the total is not covered', async () => {
                const { process, paymentRepo } = await createProcess(
                    {},
                    {
                        payment: {
                            find: vi.fn().mockResolvedValue([new Payment({ state: 'Settled', amount: 800 })]),
                        },
                    },
                );
                const order = payingOrder(1000, []);

                const result = await transitionStart(
                    process,
                    'ArrangingAdditionalPayment',
                    'PaymentSettled',
                    order,
                );

                expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
                expect(paymentRepo.find).toHaveBeenCalledWith({
                    relations: ['refunds'],
                    where: { order: { id: order.id } },
                });
            });

            it('loads the Payments onto the Order and allows the transition when covered', async () => {
                const payments = [new Payment({ state: 'Settled', amount: 1000 })];
                const { process } = await createProcess(
                    {},
                    { payment: { find: vi.fn().mockResolvedValue(payments) } },
                );
                const order = payingOrder(1000, []);

                const result = await transitionStart(
                    process,
                    'ArrangingAdditionalPayment',
                    'PaymentSettled',
                    order,
                );

                expect(result).toBeUndefined();
                expect(order.payments).toBe(payments);
            });

            it('subtracts settled refunds when computing the deficit', async () => {
                const payment = new Payment({
                    state: 'Settled',
                    amount: 1000,
                    refunds: [new Refund({ state: 'Settled', total: 200 })],
                });
                const { process } = await createProcess(
                    {},
                    { payment: { find: vi.fn().mockResolvedValue([payment]) } },
                );

                const result = await transitionStart(
                    process,
                    'ArrangingAdditionalPayment',
                    'PaymentSettled',
                    payingOrder(1000, []),
                );

                expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
            });

            it('always allows ArrangingAdditionalPayment -> Cancelled without loading payments', async () => {
                const { process, paymentRepo } = await createProcess({ checkAllItemsBeforeCancel: false });

                const result = await transitionStart(
                    process,
                    'ArrangingAdditionalPayment',
                    'Cancelled',
                    payingOrder(1000, []),
                );

                expect(result).toBeUndefined();
                expect(paymentRepo.find).not.toHaveBeenCalled();
            });

            it('skips the check when checkAdditionalPaymentsAmount is false', async () => {
                const { process, paymentRepo } = await createProcess({
                    checkAdditionalPaymentsAmount: false,
                    checkPaymentsCoverTotal: false,
                });

                const result = await transitionStart(
                    process,
                    'ArrangingAdditionalPayment',
                    'PaymentSettled',
                    payingOrder(1000, []),
                );

                expect(result).toBeUndefined();
                expect(paymentRepo.find).not.toHaveBeenCalled();
            });
        });

        describe('transition to ArrangingPayment', () => {
            function checkoutReadyOrder(): Order {
                const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 10 }]);
                order.customer = { id: 1 } as any;
                order.shippingLines = [new ShippingLine({ id: 1 })];
                order.lines[0].productVariant.name = 'Widget' as LocaleString;
                return order;
            }

            it('rejects an empty Order', async () => {
                const { process } = await createProcess();
                const order = createOrderFromLines([]);

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-when-order-is-empty');
            });

            it('allows an empty Order when arrangingPaymentRequiresContents is false', async () => {
                const { process } = await createProcess({ arrangingPaymentRequiresContents: false });
                const order = createOrderFromLines([]);
                order.customer = { id: 1 } as any;
                order.shippingLines = [new ShippingLine({ id: 1 })];

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('rejects an Order with no customer', async () => {
                const { process } = await createProcess();
                const order = checkoutReadyOrder();
                order.customer = undefined as any;

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-customer');
            });

            it('allows an Order with no customer when arrangingPaymentRequiresCustomer is false', async () => {
                const { process } = await createProcess({ arrangingPaymentRequiresCustomer: false });
                const order = checkoutReadyOrder();
                order.customer = undefined as any;

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('rejects an Order with no shipping lines', async () => {
                const { process } = await createProcess();
                const order = checkoutReadyOrder();
                order.shippingLines = [];

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-shipping-method');
            });

            it('rejects an Order whose shippingLines relation is not loaded', async () => {
                const { process } = await createProcess();
                const order = checkoutReadyOrder();
                order.shippingLines = undefined as any;

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBe('message.cannot-transition-to-payment-without-shipping-method');
            });

            it('allows no shipping lines when arrangingPaymentRequiresShipping is false', async () => {
                const { process } = await createProcess({ arrangingPaymentRequiresShipping: false });
                const order = checkoutReadyOrder();
                order.shippingLines = [];

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order);

                expect(result).toBeUndefined();
            });

            it('rejects when saleable stock is insufficient, naming the variants', async () => {
                const { process, productVariantService } = await createProcess();
                productVariantService.getSaleableStockLevel.mockResolvedValue(1);
                const order = checkoutReadyOrder();
                const ctx = RequestContext.empty();
                const translate = vi.spyOn(ctx, 'translate').mockReturnValue('translated');

                const result = await transitionStart(process, 'Draft', 'ArrangingPayment', order, ctx);

                expect(result).toBe('translated');
                expect(translate).toHaveBeenCalledWith(
                    'message.cannot-transition-to-payment-due-to-insufficient-stock',
                    { productVariantNames: 'Widget' },
                );
                expect(productVariantService.getSaleableStockLevel).toHaveBeenCalledWith(
                    ctx,
                    order.lines[0].productVariant,
                );
            });

            it('allows the transition when saleable stock covers every line', async () => {
                const { process, productVariantService } = await createProcess();
                productVariantService.getSaleableStockLevel.mockResolvedValue(2);

                const result = await transitionStart(
                    process,
                    'Draft',
                    'ArrangingPayment',
                    checkoutReadyOrder(),
                );

                expect(result).toBeUndefined();
            });

            it('does not consult stock levels when arrangingPaymentRequiresStock is false', async () => {
                const { process, productVariantService } = await createProcess({
                    arrangingPaymentRequiresStock: false,
                });
                productVariantService.getSaleableStockLevel.mockResolvedValue(0);

                const result = await transitionStart(
                    process,
                    'Draft',
                    'ArrangingPayment',
                    checkoutReadyOrder(),
                );

                expect(result).toBeUndefined();
                expect(productVariantService.getSaleableStockLevel).not.toHaveBeenCalled();
            });

            it('does not query ProductVariants from AddingItems when checkAllVariantsExist is false', async () => {
                const { process, connection } = await createProcess({ checkAllVariantsExist: false });

                const result = await transitionStart(
                    process,
                    'AddingItems',
                    'ArrangingPayment',
                    checkoutReadyOrder(),
                );

                expect(result).toBeUndefined();
                expect(connection.getRepository).not.toHaveBeenCalledWith(expect.anything(), ProductVariant);
            });
        });

        describe('checkPaymentsCoverTotal', () => {
            it('blocks PaymentAuthorized when there is no Authorized payment', async () => {
                const { process } = await createProcess();
                const order = payingOrder(1000, [new Payment({ state: 'Settled', amount: 1000 })]);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBe('message.cannot-transition-without-authorized-payments');
            });

            it('blocks PaymentAuthorized when authorized + settled payments do not cover the total', async () => {
                const { process } = await createProcess();
                const order = payingOrder(1000, [new Payment({ state: 'Authorized', amount: 999 })]);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBe('message.cannot-transition-without-authorized-payments');
            });

            it('allows PaymentAuthorized when a mix of Authorized and Settled payments cover the total', async () => {
                const { process } = await createProcess();
                const order = payingOrder(1000, [
                    new Payment({ state: 'Authorized', amount: 400 }),
                    new Payment({ state: 'Settled', amount: 600 }),
                ]);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

                expect(result).toBeUndefined();
            });

            it('blocks PaymentSettled when settled payments do not cover the total', async () => {
                const { process } = await createProcess();
                const order = payingOrder(1000, [
                    new Payment({ state: 'Authorized', amount: 500 }),
                    new Payment({ state: 'Settled', amount: 500 }),
                ]);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

                expect(result).toBe('message.cannot-transition-without-settled-payments');
            });

            it('allows PaymentSettled when settled payments cover the total', async () => {
                const { process } = await createProcess();
                const order = payingOrder(1000, [new Payment({ state: 'Settled', amount: 1000 })]);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

                expect(result).toBeUndefined();
            });

            it('skips the check when checkPaymentsCoverTotal is false', async () => {
                const { process } = await createProcess({ checkPaymentsCoverTotal: false });
                const order = payingOrder(1000, []);

                const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

                expect(result).toBeUndefined();
            });
        });

        describe('checkAllItemsBeforeCancel', () => {
            it('blocks Cancelled from a post-checkout state when lines still have quantity', async () => {
                const { process } = await createProcess();
                const order = createOrderFromLines([
                    { lineId: 1, quantity: 0, productVariantId: 1 },
                    { lineId: 2, quantity: 1, productVariantId: 2 },
                ]);

                const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

                expect(result).toBe('message.cannot-transition-unless-all-cancelled');
            });

            it('allows Cancelled from a post-checkout state when all lines are cancelled', async () => {
                const { process } = await createProcess();
                const order = createOrderFromLines([{ lineId: 1, quantity: 0, productVariantId: 1 }]);

                const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

                expect(result).toBeUndefined();
            });

            it.each<OrderState>(['AddingItems', 'ArrangingPayment'])(
                'allows Cancelled from %s regardless of line quantities',
                async fromState => {
                    const { process } = await createProcess({ checkAllVariantsExist: false });
                    const order = createOrderFromLines([{ lineId: 1, quantity: 3, productVariantId: 1 }]);

                    const result = await transitionStart(process, fromState, 'Cancelled', order);

                    expect(result).toBeUndefined();
                },
            );

            it('skips the check when checkAllItemsBeforeCancel is false', async () => {
                const { process } = await createProcess({ checkAllItemsBeforeCancel: false });
                const order = createOrderFromLines([{ lineId: 1, quantity: 3, productVariantId: 1 }]);

                const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

                expect(result).toBeUndefined();
            });
        });

        describe('checkFulfillmentStates', () => {
            const ctx = RequestContext.empty();

            it('loads the Order with its fulfillments before checking', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                const loaded = orderWithFulfillments(
                    [2],
                    [{ state: 'Shipped', lines: [{ lineIndex: 0, quantity: 2 }] }],
                );
                getEntityOrThrow.mockResolvedValue(loaded);
                const order = new Order({ id: 42, lines: [] });

                await transitionStart(process, 'PaymentSettled', 'Shipped', order, ctx);

                expect(getEntityOrThrow).toHaveBeenCalledWith(ctx, Order, 42, {
                    relations: [
                        'lines',
                        'fulfillments',
                        'fulfillments.lines',
                        'fulfillments.lines.fulfillment',
                    ],
                });
            });

            it('allows Shipped when every line is fully shipped', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [2, 1],
                        [
                            {
                                state: 'Shipped',
                                lines: [
                                    { lineIndex: 0, quantity: 2 },
                                    { lineIndex: 1, quantity: 1 },
                                ],
                            },
                        ],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'Shipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBeUndefined();
            });

            it('blocks Shipped when only some lines are shipped', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [2, 1],
                        [{ state: 'Shipped', lines: [{ lineIndex: 0, quantity: 2 }] }],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'Shipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBe('message.cannot-transition-unless-all-order-items-shipped');
            });

            it('allows PartiallyShipped when some but not all lines are shipped', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [2, 1],
                        [{ state: 'Shipped', lines: [{ lineIndex: 0, quantity: 2 }] }],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'PartiallyShipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBeUndefined();
            });

            it('blocks PartiallyShipped when nothing has shipped', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(orderWithFulfillments([2], []));

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'PartiallyShipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBe('message.cannot-transition-unless-some-order-items-shipped');
            });

            it('allows Delivered when every line is delivered', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [3],
                        [{ state: 'Delivered', lines: [{ lineIndex: 0, quantity: 3 }] }],
                    ),
                );

                const result = await transitionStart(process, 'Shipped', 'Delivered', new Order({ id: 1 }));

                expect(result).toBeUndefined();
            });

            it('blocks Delivered when a fulfillment is only Shipped', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [1, 1],
                        [
                            { state: 'Delivered', lines: [{ lineIndex: 0, quantity: 1 }] },
                            { state: 'Shipped', lines: [{ lineIndex: 1, quantity: 1 }] },
                        ],
                    ),
                );

                const result = await transitionStart(process, 'Shipped', 'Delivered', new Order({ id: 1 }));

                expect(result).toBe('message.cannot-transition-unless-all-order-items-delivered');
            });

            it('allows PartiallyDelivered when some lines are delivered', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [1, 1],
                        [
                            { state: 'Delivered', lines: [{ lineIndex: 0, quantity: 1 }] },
                            { state: 'Shipped', lines: [{ lineIndex: 1, quantity: 1 }] },
                        ],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'Shipped',
                    'PartiallyDelivered',
                    new Order({ id: 1 }),
                );

                expect(result).toBeUndefined();
            });

            it('blocks PartiallyDelivered when nothing is delivered', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [1],
                        [{ state: 'Shipped', lines: [{ lineIndex: 0, quantity: 1 }] }],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'Shipped',
                    'PartiallyDelivered',
                    new Order({ id: 1 }),
                );

                expect(result).toBe('message.cannot-transition-unless-some-order-items-delivered');
            });

            it('ignores Cancelled fulfillments', async () => {
                const { process, getEntityOrThrow } = await createProcess();
                getEntityOrThrow.mockResolvedValue(
                    orderWithFulfillments(
                        [1],
                        [{ state: 'Cancelled', lines: [{ lineIndex: 0, quantity: 1 }] }],
                    ),
                );

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'Shipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBe('message.cannot-transition-unless-all-order-items-shipped');
            });

            it('skips fulfillment checks when checkFulfillmentStates is false', async () => {
                const { process, getEntityOrThrow } = await createProcess({ checkFulfillmentStates: false });

                const result = await transitionStart(
                    process,
                    'PaymentSettled',
                    'Shipped',
                    new Order({ id: 1 }),
                );

                expect(result).toBeUndefined();
                expect(getEntityOrThrow).not.toHaveBeenCalled();
            });
        });
    });

    describe('onTransitionEnd()', () => {
        let ctx: RequestContext;

        beforeEach(() => {
            ctx = RequestContext.empty();
        });

        it('always records an ORDER_STATE_TRANSITION history entry', async () => {
            const { process, historyService } = await createProcess();
            const order = createOrderFromLines([]);
            order.id = 7;
            order.active = false;

            await transitionEnd(process, 'PaymentSettled', 'Shipped', order, ctx);

            expect(historyService.createHistoryEntryForOrder).toHaveBeenCalledWith({
                orderId: 7,
                type: HistoryEntryType.ORDER_STATE_TRANSITION,
                ctx,
                data: { from: 'PaymentSettled', to: 'Shipped' },
            });
        });

        it('places the Order when the OrderPlacedStrategy says so', async () => {
            const { process, orderLineRepo, eventBus, orderSplitter } = await createProcess();
            const order = createOrderFromLines([
                { lineId: 1, quantity: 2, productVariantId: 1 },
                { lineId: 2, quantity: 5, productVariantId: 2 },
            ]);
            order.id = 1;
            order.active = true;
            const before = Date.now();

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order, ctx);

            expect(order.active).toBe(false);
            expect(order.orderPlacedAt).toBeInstanceOf(Date);
            expect(order.orderPlacedAt?.getTime()).toBeGreaterThanOrEqual(before);
            expect(order.lines.map(l => l.orderPlacedQuantity)).toEqual([2, 5]);
            expect(orderLineRepo.update).toHaveBeenCalledTimes(2);
            expect(orderLineRepo.update).toHaveBeenCalledWith(1, { orderPlacedQuantity: 2 });
            expect(orderLineRepo.update).toHaveBeenCalledWith(2, { orderPlacedQuantity: 5 });
            expect(eventBus.publish).toHaveBeenCalledTimes(1);
            const event = eventBus.publish.mock.calls[0][0] as OrderPlacedEvent;
            expect(event).toBeInstanceOf(OrderPlacedEvent);
            expect(event.fromState).toBe('ArrangingPayment');
            expect(event.toState).toBe('PaymentSettled');
            expect(event.order).toBe(order);
            expect(orderSplitter.createSellerOrders).toHaveBeenCalledWith(ctx, order);
        });

        it('does not place an Order which is not active', async () => {
            const { process, orderLineRepo, eventBus, orderSplitter } = await createProcess();
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 1 }]);
            order.active = false;

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order, ctx);

            expect(order.orderPlacedAt).toBeUndefined();
            expect(orderLineRepo.update).not.toHaveBeenCalled();
            expect(eventBus.publish).not.toHaveBeenCalled();
            expect(orderSplitter.createSellerOrders).not.toHaveBeenCalled();
        });

        it('does not place an Order for a transition the strategy does not consider placement', async () => {
            const { process, eventBus, orderSplitter } = await createProcess();
            const order = createOrderFromLines([{ lineId: 1, quantity: 2, productVariantId: 1 }]);
            order.active = true;

            await transitionEnd(process, 'AddingItems', 'ArrangingPayment', order, ctx);

            expect(order.active).toBe(true);
            expect(eventBus.publish).not.toHaveBeenCalled();
            expect(orderSplitter.createSellerOrders).not.toHaveBeenCalled();
        });

        it('delegates the placement decision to the configured OrderPlacedStrategy', async () => {
            const { process, configService, eventBus } = await createProcess();
            const shouldSetAsPlaced = vi.fn().mockReturnValue(true);
            configService.orderOptions.orderPlacedStrategy = { shouldSetAsPlaced };
            const order = createOrderFromLines([]);
            order.active = true;

            await transitionEnd(process, 'AddingItems', 'ArrangingPayment', order, ctx);

            expect(shouldSetAsPlaced).toHaveBeenCalledWith(ctx, 'AddingItems', 'ArrangingPayment', order);
            expect(order.active).toBe(false);
            expect(eventBus.publish).toHaveBeenCalledTimes(1);
        });

        it('allocates stock when the StockAllocationStrategy says so', async () => {
            const { process, stockMovementService } = await createProcess();
            const order = createOrderFromLines([]);
            order.active = false;

            await transitionEnd(process, 'ArrangingPayment', 'PaymentAuthorized', order, ctx);

            expect(stockMovementService.createAllocationsForOrder).toHaveBeenCalledWith(ctx, order);
        });

        it('does not allocate stock for other transitions', async () => {
            const { process, stockMovementService } = await createProcess();
            const order = createOrderFromLines([]);
            order.active = false;

            await transitionEnd(process, 'PaymentAuthorized', 'PaymentSettled', order, ctx);

            expect(stockMovementService.createAllocationsForOrder).not.toHaveBeenCalled();
        });

        it('awaits an async StockAllocationStrategy', async () => {
            const { process, configService, stockMovementService } = await createProcess();
            configService.orderOptions.stockAllocationStrategy = {
                shouldAllocateStock: vi.fn().mockResolvedValue(true),
            };
            const order = createOrderFromLines([]);
            order.active = false;

            await transitionEnd(process, 'PaymentAuthorized', 'PaymentSettled', order, ctx);

            expect(stockMovementService.createAllocationsForOrder).toHaveBeenCalledWith(ctx, order);
        });

        it('sets the Order inactive on Cancelled', async () => {
            const { process } = await createProcess();
            const order = createOrderFromLines([]);
            order.active = true;

            await transitionEnd(process, 'AddingItems', 'Cancelled', order, ctx);

            expect(order.active).toBe(false);
        });

        it('sets the Order active on Draft -> ArrangingPayment', async () => {
            const { process } = await createProcess();
            const order = createOrderFromLines([]);
            order.active = false;

            await transitionEnd(process, 'Draft', 'ArrangingPayment', order, ctx);

            expect(order.active).toBe(true);
        });

        it('leaves the active flag alone on unrelated transitions', async () => {
            const { process } = await createProcess();
            const order = createOrderFromLines([]);
            order.active = false;

            await transitionEnd(process, 'PaymentSettled', 'Shipped', order, ctx);

            expect(order.active).toBe(false);
        });
    });
});
