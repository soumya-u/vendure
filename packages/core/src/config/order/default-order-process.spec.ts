import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../api/common/request-context';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Channel } from '../../entity/channel/channel.entity';
import { Fulfillment } from '../../entity/fulfillment/fulfillment.entity';
import { FulfillmentLine } from '../../entity/order-line-reference/fulfillment-line.entity';
import { OrderLine } from '../../entity/order-line/order-line.entity';
import { OrderModification } from '../../entity/order-modification/order-modification.entity';
import { Order } from '../../entity/order/order.entity';
import { Payment } from '../../entity/payment/payment.entity';
import { ProductVariant } from '../../entity/product-variant/product-variant.entity';
import { OrderPlacedEvent } from '../../event-bus/events/order-placed-event';
import { OrderState } from '../../service/helpers/order-state-machine/order-state';

import { configureDefaultOrderProcess, DefaultOrderProcessOptions } from './default-order-process';
import { OrderProcess } from './order-process';

/**
 * Unit tests for the guards of the default OrderProcess. Each guard returns either `undefined`
 * (transition allowed) or a message key (transition rejected), so every test asserts on which of
 * those two outcomes a given Order shape produces.
 */

const TRANSLATED = 'translated';

function createCtx(): RequestContext {
    return new RequestContext({
        apiType: 'admin',
        channel: new Channel({ id: 'T_1' }),
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
        session: {} as any,
        translationFn: ((key: string, variables?: any) =>
            `${TRANSLATED}:${key}:${JSON.stringify(variables ?? {})}`) as any,
    });
}

function createVariant(id: string, name = `variant-${id}`): ProductVariant {
    return new ProductVariant({ id, name });
}

function createLine(overrides: Partial<OrderLine> = {}): OrderLine {
    return new OrderLine({
        id: 'T_1',
        quantity: 1,
        productVariant: createVariant('T_1'),
        ...overrides,
    } as any);
}

function createOrder(overrides: Partial<Order> = {}): Order {
    return new Order({
        id: 'T_1',
        lines: [createLine()],
        payments: [],
        fulfillments: [],
        shippingLines: [{ id: 'T_1' }],
        customer: { id: 'T_1' },
        subTotalWithTax: 1000,
        shippingWithTax: 0,
        ...overrides,
    } as any);
}

function createPayment(amount: number, state: string, refunds: Array<Partial<any>> = []): Payment {
    return new Payment({ amount, state, refunds } as any);
}

/**
 * Builds an Order with a single line of the given quantity, fulfilled by Fulfillments in the
 * given states. Each entry of `fulfilled` is one Fulfillment covering `quantity` items.
 */
function createOrderWithFulfillments(
    lineQuantity: number,
    fulfilled: Array<{ state: string; quantity: number }>,
): Order {
    const line = createLine({ id: 'T_1', quantity: lineQuantity } as any);
    const fulfillments = fulfilled.map((f, i) => {
        const fulfillment = new Fulfillment({ id: `T_${i + 1}`, state: f.state, lines: [] } as any);
        fulfillment.lines = [
            new FulfillmentLine({
                orderLineId: line.id,
                quantity: f.quantity,
                fulfillment,
            } as any),
        ];
        return fulfillment;
    });
    return createOrder({ lines: [line], fulfillments } as any);
}

describe('defaultOrderProcess', () => {
    let ctx: RequestContext;
    let orderModifications: OrderModification[];
    let existingPayments: Payment[];
    let availableVariants: ProductVariant[];
    let orderWithFulfillments: Order;
    let getSaleableStockLevel: ReturnType<typeof vi.fn>;
    let shouldSetAsPlaced: ReturnType<typeof vi.fn>;
    let shouldAllocateStock: ReturnType<typeof vi.fn>;
    let createAllocationsForOrder: ReturnType<typeof vi.fn>;
    let createHistoryEntryForOrder: ReturnType<typeof vi.fn>;
    let createSellerOrders: ReturnType<typeof vi.fn>;
    let publish: ReturnType<typeof vi.fn>;
    let orderLineUpdate: ReturnType<typeof vi.fn>;
    let modificationFind: ReturnType<typeof vi.fn>;
    let paymentFind: ReturnType<typeof vi.fn>;
    let getEntityOrThrow: ReturnType<typeof vi.fn>;

    async function createProcess(
        options: DefaultOrderProcessOptions = {},
    ): Promise<OrderProcess<OrderState>> {
        const process = configureDefaultOrderProcess(options);
        modificationFind = vi.fn(async () => orderModifications);
        paymentFind = vi.fn(async () => existingPayments);
        orderLineUpdate = vi.fn(async () => undefined);
        getEntityOrThrow = vi.fn(async () => orderWithFulfillments);
        const variantQueryBuilder: any = {
            leftJoin: () => variantQueryBuilder,
            where: () => variantQueryBuilder,
            andWhere: () => variantQueryBuilder,
            getMany: async () => availableVariants,
        };
        const connection = {
            getRepository: (_ctx: RequestContext, entity: any) => {
                switch (entity) {
                    case OrderModification:
                        return { find: modificationFind };
                    case Payment:
                        return { find: paymentFind };
                    case ProductVariant:
                        return { createQueryBuilder: () => variantQueryBuilder };
                    case OrderLine:
                        return { update: orderLineUpdate };
                    default:
                        throw new Error(`No mock repository for ${String(entity)}`);
                }
            },
            getEntityOrThrow,
        };
        const providers: { [name: string]: any } = {
            TransactionalConnection: connection,
            ProductVariantService: { getSaleableStockLevel },
            ConfigService: {
                orderOptions: {
                    stockAllocationStrategy: { shouldAllocateStock },
                    orderPlacedStrategy: { shouldSetAsPlaced },
                },
            },
            EventBus: { publish },
            StockMovementService: { createAllocationsForOrder },
            StockLevelService: {},
            HistoryService: { createHistoryEntryForOrder },
            OrderSplitter: { createSellerOrders },
        };
        const injector = {
            get: (token: any) => {
                const provider =
                    providers[token === TransactionalConnection ? 'TransactionalConnection' : token.name];
                if (!provider) {
                    throw new Error(`No mock provider for ${String(token.name)}`);
                }
                return provider;
            },
        };
        await process.init?.(injector as any);
        return process;
    }

    function transitionStart(
        process: OrderProcess<OrderState>,
        from: OrderState,
        to: OrderState,
        order: Order,
    ) {
        return process.onTransitionStart?.(from, to, { ctx, order } as any);
    }

    beforeEach(() => {
        ctx = createCtx();
        orderModifications = [];
        existingPayments = [];
        availableVariants = [];
        orderWithFulfillments = createOrder();
        getSaleableStockLevel = vi.fn(async () => 100);
        shouldSetAsPlaced = vi.fn(() => false);
        shouldAllocateStock = vi.fn(async () => false);
        createAllocationsForOrder = vi.fn(async () => undefined);
        createHistoryEntryForOrder = vi.fn(async () => undefined);
        createSellerOrders = vi.fn(async () => []);
        publish = vi.fn(async () => undefined);
    });

    describe('transition graph', () => {
        it('allows no transitions out of the Cancelled state', async () => {
            const process = await createProcess();

            expect(process.transitions?.Cancelled.to).toEqual([]);
        });

        it('only allows a Draft Order to be cancelled or moved to ArrangingPayment', async () => {
            const process = await createProcess();

            expect(process.transitions?.Draft.to).toEqual(['Cancelled', 'ArrangingPayment']);
        });
    });

    describe('checkModificationPayments', () => {
        it('rejects leaving Modifying while a Modification is unsettled', async () => {
            const process = await createProcess();
            orderModifications = [new OrderModification({ priceChange: 500 } as any)];

            const result = await transitionStart(process, 'Modifying', 'PaymentSettled', createOrder());

            expect(result).toBe('message.cannot-transition-without-modification-payment');
        });

        it('allows leaving Modifying when all Modifications are settled', async () => {
            const process = await createProcess();
            orderModifications = [new OrderModification({ priceChange: 500, payment: { id: 'T_1' } } as any)];

            const result = await transitionStart(
                process,
                'Modifying',
                'PaymentSettled',
                createOrder({ payments: [createPayment(1000, 'Settled')] } as any),
            );

            expect(result).toBeUndefined();
        });

        it('rejects ArrangingAdditionalPayment when every Modification is already settled', async () => {
            const process = await createProcess();
            orderModifications = [new OrderModification({ priceChange: 0 } as any)];

            const result = await transitionStart(
                process,
                'Modifying',
                'ArrangingAdditionalPayment',
                createOrder(),
            );

            expect(result).toBe('message.cannot-transition-no-additional-payments-needed');
        });

        it('allows ArrangingAdditionalPayment when a Modification still needs paying', async () => {
            const process = await createProcess();
            orderModifications = [new OrderModification({ priceChange: 500 } as any)];

            const result = await transitionStart(
                process,
                'Modifying',
                'ArrangingAdditionalPayment',
                createOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('allows ArrangingAdditionalPayment when there are no Modifications at all', async () => {
            const process = await createProcess();
            orderModifications = [];

            const result = await transitionStart(
                process,
                'Modifying',
                'ArrangingAdditionalPayment',
                createOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkModificationPayments: false });
            orderModifications = [new OrderModification({ priceChange: 500 } as any)];

            const result = await transitionStart(
                process,
                'Modifying',
                'PaymentSettled',
                createOrder({ payments: [createPayment(1000, 'Settled')] } as any),
            );

            expect(result).toBeUndefined();
            expect(modificationFind).not.toHaveBeenCalled();
        });
    });

    describe('checkAdditionalPaymentsAmount', () => {
        it('rejects leaving ArrangingAdditionalPayment while the total is not covered', async () => {
            const process = await createProcess();
            existingPayments = [createPayment(500, 'Settled')];

            const result = await transitionStart(
                process,
                'ArrangingAdditionalPayment',
                'PaymentSettled',
                createOrder(),
            );

            expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
        });

        it('allows leaving ArrangingAdditionalPayment once the Payments cover the total', async () => {
            const process = await createProcess();
            existingPayments = [createPayment(600, 'Settled'), createPayment(400, 'Settled')];

            const result = await transitionStart(
                process,
                'ArrangingAdditionalPayment',
                'PaymentSettled',
                createOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('discounts settled Refunds when checking the covered amount', async () => {
            const process = await createProcess();
            existingPayments = [createPayment(1000, 'Settled', [{ state: 'Settled', total: 200 }])];

            const result = await transitionStart(
                process,
                'ArrangingAdditionalPayment',
                'PaymentSettled',
                createOrder(),
            );

            expect(result).toBe('message.cannot-transition-from-arranging-additional-payment');
        });

        it('loads the Payments onto the Order being transitioned', async () => {
            const process = await createProcess();
            existingPayments = [createPayment(1000, 'Settled')];
            const order = createOrder();

            await transitionStart(process, 'ArrangingAdditionalPayment', 'PaymentSettled', order);

            expect(order.payments).toBe(existingPayments);
        });

        it('allows cancelling from ArrangingAdditionalPayment without checking Payments', async () => {
            const process = await createProcess();
            const order = createOrder({ lines: [createLine({ quantity: 0 } as any)] } as any);

            const result = await transitionStart(process, 'ArrangingAdditionalPayment', 'Cancelled', order);

            expect(result).toBeUndefined();
            expect(paymentFind).not.toHaveBeenCalled();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkAdditionalPaymentsAmount: false });
            existingPayments = [createPayment(1, 'Settled')];

            const result = await transitionStart(
                process,
                'ArrangingAdditionalPayment',
                'PaymentSettled',
                createOrder({ payments: [createPayment(1000, 'Settled')] } as any),
            );

            expect(result).toBeUndefined();
            expect(paymentFind).not.toHaveBeenCalled();
        });
    });

    describe('checkAllVariantsExist', () => {
        it('rejects the transition when a ProductVariant in the Order no longer exists', async () => {
            const process = await createProcess();
            const order = createOrder({
                lines: [
                    createLine({ id: 'T_1', productVariant: createVariant('T_1') } as any),
                    createLine({ id: 'T_2', productVariant: createVariant('T_2') } as any),
                ],
            } as any);
            availableVariants = [createVariant('T_1')];

            const result = await transitionStart(process, 'AddingItems', 'ArrangingPayment', order);

            expect(result).toBe('message.cannot-transition-order-contains-products-which-are-unavailable');
        });

        it('allows the transition when all ProductVariants still exist', async () => {
            const process = await createProcess();
            availableVariants = [createVariant('T_1')];

            const result = await transitionStart(process, 'AddingItems', 'ArrangingPayment', createOrder());

            expect(result).toBeUndefined();
        });

        it('does not block cancellation of an Order containing a deleted ProductVariant', async () => {
            const process = await createProcess();
            availableVariants = [];

            const result = await transitionStart(
                process,
                'AddingItems',
                'Cancelled',
                createOrder({ lines: [createLine({ quantity: 0 } as any)] } as any),
            );

            expect(result).toBeUndefined();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkAllVariantsExist: false });
            availableVariants = [];

            const result = await transitionStart(process, 'AddingItems', 'ArrangingPayment', createOrder());

            expect(result).toBeUndefined();
        });
    });

    describe('transition to ArrangingPayment', () => {
        it('rejects an Order with no lines', async () => {
            const process = await createProcess();

            const result = await transitionStart(
                process,
                'AddingItems',
                'ArrangingPayment',
                createOrder({ lines: [] } as any),
            );

            expect(result).toBe('message.cannot-transition-to-payment-when-order-is-empty');
        });

        it('rejects an Order with no Customer', async () => {
            const process = await createProcess();
            availableVariants = [createVariant('T_1')];

            const result = await transitionStart(
                process,
                'AddingItems',
                'ArrangingPayment',
                createOrder({ customer: undefined } as any),
            );

            expect(result).toBe('message.cannot-transition-to-payment-without-customer');
        });

        it('rejects an Order with no ShippingLines', async () => {
            const process = await createProcess();
            availableVariants = [createVariant('T_1')];

            const result = await transitionStart(
                process,
                'AddingItems',
                'ArrangingPayment',
                createOrder({ shippingLines: [] } as any),
            );

            expect(result).toBe('message.cannot-transition-to-payment-without-shipping-method');
        });

        it('rejects an Order whose lines exceed the saleable stock, naming the variants', async () => {
            const process = await createProcess();
            availableVariants = [createVariant('T_1')];
            getSaleableStockLevel.mockResolvedValue(1);
            const order = createOrder({
                lines: [
                    createLine({
                        id: 'T_1',
                        quantity: 5,
                        productVariant: createVariant('T_1', 'Laptop'),
                    } as any),
                ],
            } as any);

            const result = await transitionStart(process, 'AddingItems', 'ArrangingPayment', order);

            expect(result).toContain('message.cannot-transition-to-payment-due-to-insufficient-stock');
            expect(result).toContain('Laptop');
        });

        it('allows an Order whose lines are exactly covered by the saleable stock', async () => {
            const process = await createProcess();
            availableVariants = [createVariant('T_1')];
            getSaleableStockLevel.mockResolvedValue(5);

            const result = await transitionStart(
                process,
                'AddingItems',
                'ArrangingPayment',
                createOrder({ lines: [createLine({ quantity: 5 } as any)] } as any),
            );

            expect(result).toBeUndefined();
        });

        it('skips the individual checks when their options are disabled', async () => {
            const process = await createProcess({
                arrangingPaymentRequiresContents: false,
                arrangingPaymentRequiresCustomer: false,
                arrangingPaymentRequiresShipping: false,
                arrangingPaymentRequiresStock: false,
            });

            const result = await transitionStart(
                process,
                'AddingItems',
                'ArrangingPayment',
                createOrder({ lines: [], customer: undefined, shippingLines: [] } as any),
            );

            expect(result).toBeUndefined();
            expect(getSaleableStockLevel).not.toHaveBeenCalled();
        });
    });

    describe('checkPaymentsCoverTotal', () => {
        it('rejects PaymentAuthorized when the total is not covered', async () => {
            const process = await createProcess();
            const order = createOrder({ payments: [createPayment(500, 'Authorized')] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

            expect(result).toBe('message.cannot-transition-without-authorized-payments');
        });

        it('rejects PaymentAuthorized when the total is covered but no Payment is Authorized', async () => {
            const process = await createProcess();
            const order = createOrder({ payments: [createPayment(1000, 'Settled')] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

            expect(result).toBe('message.cannot-transition-without-authorized-payments');
        });

        it('allows PaymentAuthorized when an authorized Payment covers the total', async () => {
            const process = await createProcess();
            const order = createOrder({ payments: [createPayment(1000, 'Authorized')] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentAuthorized', order);

            expect(result).toBeUndefined();
        });

        it('rejects PaymentSettled when the settled Payments do not cover the total', async () => {
            const process = await createProcess();
            const order = createOrder({
                payments: [createPayment(1000, 'Authorized'), createPayment(999, 'Settled')],
            } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(result).toBe('message.cannot-transition-without-settled-payments');
        });

        it('allows PaymentSettled when the settled Payments cover the total', async () => {
            const process = await createProcess();
            const order = createOrder({ payments: [createPayment(1000, 'Settled')] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(result).toBeUndefined();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkPaymentsCoverTotal: false });
            const order = createOrder({ payments: [] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(result).toBeUndefined();
        });
    });

    describe('checkAllItemsBeforeCancel', () => {
        it('rejects cancellation of a placed Order with uncancelled lines', async () => {
            const process = await createProcess();
            const order = createOrder({ lines: [createLine({ quantity: 2 } as any)] } as any);

            const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

            expect(result).toBe('message.cannot-transition-unless-all-cancelled');
        });

        it('allows cancellation once every line has been cancelled', async () => {
            const process = await createProcess();
            const order = createOrder({ lines: [createLine({ quantity: 0 } as any)] } as any);

            const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

            expect(result).toBeUndefined();
        });

        it('allows cancellation from AddingItems without cancelling the lines first', async () => {
            const process = await createProcess();
            const order = createOrder({ lines: [createLine({ quantity: 2 } as any)] } as any);

            const result = await transitionStart(process, 'AddingItems', 'Cancelled', order);

            expect(result).toBeUndefined();
        });

        it('allows cancellation from ArrangingPayment without cancelling the lines first', async () => {
            const process = await createProcess();
            const order = createOrder({ lines: [createLine({ quantity: 2 } as any)] } as any);

            const result = await transitionStart(process, 'ArrangingPayment', 'Cancelled', order);

            expect(result).toBeUndefined();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkAllItemsBeforeCancel: false });
            const order = createOrder({ lines: [createLine({ quantity: 2 } as any)] } as any);

            const result = await transitionStart(process, 'PaymentSettled', 'Cancelled', order);

            expect(result).toBeUndefined();
        });
    });

    describe('checkFulfillmentStates', () => {
        it('rejects Shipped when only part of the Order is shipped', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Shipped', quantity: 1 }]);

            const result = await transitionStart(process, 'PaymentSettled', 'Shipped', createOrder());

            expect(result).toBe('message.cannot-transition-unless-all-order-items-shipped');
        });

        it('allows Shipped when the whole Order is shipped', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Shipped', quantity: 2 }]);

            const result = await transitionStart(process, 'PaymentSettled', 'Shipped', createOrder());

            expect(result).toBeUndefined();
        });

        it('rejects PartiallyShipped when nothing is shipped', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Pending', quantity: 1 }]);

            const result = await transitionStart(
                process,
                'PaymentSettled',
                'PartiallyShipped',
                createOrder(),
            );

            expect(result).toBe('message.cannot-transition-unless-some-order-items-shipped');
        });

        it('allows PartiallyShipped when part of the Order is shipped', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Shipped', quantity: 1 }]);

            const result = await transitionStart(
                process,
                'PaymentSettled',
                'PartiallyShipped',
                createOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('rejects Delivered when only part of the Order is delivered', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Delivered', quantity: 1 }]);

            const result = await transitionStart(process, 'Shipped', 'Delivered', createOrder());

            expect(result).toBe('message.cannot-transition-unless-all-order-items-delivered');
        });

        it('allows Delivered when the whole Order is delivered', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Delivered', quantity: 2 }]);

            const result = await transitionStart(process, 'Shipped', 'Delivered', createOrder());

            expect(result).toBeUndefined();
        });

        it('rejects PartiallyDelivered when nothing is delivered', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Shipped', quantity: 2 }]);

            const result = await transitionStart(
                process,
                'PartiallyShipped',
                'PartiallyDelivered',
                createOrder(),
            );

            expect(result).toBe('message.cannot-transition-unless-some-order-items-delivered');
        });

        it('allows PartiallyDelivered when part of the Order is delivered', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [{ state: 'Delivered', quantity: 1 }]);

            const result = await transitionStart(
                process,
                'PartiallyShipped',
                'PartiallyDelivered',
                createOrder(),
            );

            expect(result).toBeUndefined();
        });

        it('ignores cancelled Fulfillments when deciding whether the Order is shipped', async () => {
            const process = await createProcess();
            orderWithFulfillments = createOrderWithFulfillments(2, [
                { state: 'Shipped', quantity: 2 },
                { state: 'Cancelled', quantity: 2 },
            ]);

            const result = await transitionStart(process, 'PaymentSettled', 'Shipped', createOrder());

            expect(result).toBeUndefined();
        });

        it('skips the check when disabled', async () => {
            const process = await createProcess({ checkFulfillmentStates: false });

            const result = await transitionStart(process, 'PaymentSettled', 'Shipped', createOrder());

            expect(result).toBeUndefined();
            expect(getEntityOrThrow).not.toHaveBeenCalled();
        });
    });

    describe('onTransitionEnd', () => {
        async function transitionEnd(
            process: OrderProcess<OrderState>,
            from: OrderState,
            to: OrderState,
            order: Order,
        ) {
            await process.onTransitionEnd?.(from, to, { ctx, order } as any);
        }

        it('places the Order when the OrderPlacedStrategy says so', async () => {
            const process = await createProcess();
            shouldSetAsPlaced.mockReturnValue(true);
            const order = createOrder({
                active: true,
                lines: [createLine({ quantity: 3, orderPlacedQuantity: 0 } as any)],
            } as any);

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(order.active).toBe(false);
            expect(order.orderPlacedAt).toBeInstanceOf(Date);
            expect(order.lines[0].orderPlacedQuantity).toBe(3);
            expect(orderLineUpdate).toHaveBeenCalledWith('T_1', { orderPlacedQuantity: 3 });
        });

        it('publishes an OrderPlacedEvent and splits the Order when it is placed', async () => {
            const process = await createProcess();
            shouldSetAsPlaced.mockReturnValue(true);
            const order = createOrder({ active: true } as any);

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(publish).toHaveBeenCalledTimes(1);
            const event = publish.mock.calls[0][0];
            expect(event).toBeInstanceOf(OrderPlacedEvent);
            expect(event.fromState).toBe('ArrangingPayment');
            expect(event.toState).toBe('PaymentSettled');
            expect(createSellerOrders).toHaveBeenCalledWith(ctx, order);
        });

        it('does not place an Order which is already inactive', async () => {
            const process = await createProcess();
            shouldSetAsPlaced.mockReturnValue(true);
            const order = createOrder({ active: false } as any);

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(shouldSetAsPlaced).not.toHaveBeenCalled();
            expect(order.orderPlacedAt).toBeUndefined();
            expect(publish).not.toHaveBeenCalled();
        });

        it('leaves an active Order untouched when the strategy declines to place it', async () => {
            const process = await createProcess();
            shouldSetAsPlaced.mockReturnValue(false);
            const order = createOrder({ active: true } as any);

            await transitionEnd(process, 'AddingItems', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
            expect(order.orderPlacedAt).toBeUndefined();
            expect(createSellerOrders).not.toHaveBeenCalled();
        });

        it('allocates stock when the StockAllocationStrategy says so', async () => {
            const process = await createProcess();
            shouldAllocateStock.mockResolvedValue(true);
            const order = createOrder();

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(createAllocationsForOrder).toHaveBeenCalledWith(ctx, order);
        });

        it('does not allocate stock when the StockAllocationStrategy declines', async () => {
            const process = await createProcess();
            shouldAllocateStock.mockResolvedValue(false);

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', createOrder());

            expect(createAllocationsForOrder).not.toHaveBeenCalled();
        });

        it('deactivates a cancelled Order', async () => {
            const process = await createProcess();
            const order = createOrder({ active: true } as any);

            await transitionEnd(process, 'AddingItems', 'Cancelled', order);

            expect(order.active).toBe(false);
        });

        it('activates the Order when it leaves the Draft state', async () => {
            const process = await createProcess();
            const order = createOrder({ active: false } as any);

            await transitionEnd(process, 'Draft', 'ArrangingPayment', order);

            expect(order.active).toBe(true);
        });

        it('records the transition in the Order history', async () => {
            const process = await createProcess();
            const order = createOrder();

            await transitionEnd(process, 'ArrangingPayment', 'PaymentSettled', order);

            expect(createHistoryEntryForOrder).toHaveBeenCalledWith({
                orderId: order.id,
                type: HistoryEntryType.ORDER_STATE_TRANSITION,
                ctx,
                data: { from: 'ArrangingPayment', to: 'PaymentSettled' },
            });
        });
    });
});
