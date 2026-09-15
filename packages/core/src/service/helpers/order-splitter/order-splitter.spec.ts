import { Test } from '@nestjs/testing';
import { CurrencyCode, OrderType } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { InternalServerError } from '../../../common/error/errors';
import { ConfigService } from '../../../config/config.service';
import { MockConfigService } from '../../../config/config.service.mock';
import { OrderSellerStrategy, SplitOrderContents } from '../../../config/order/order-seller-strategy';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { Customer } from '../../../entity/customer/customer.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { Order } from '../../../entity/order/order.entity';
import { ProductVariant } from '../../../entity/product-variant/product-variant.entity';
import { ShippingLine } from '../../../entity/shipping-line/shipping-line.entity';
import { ChannelService } from '../../services/channel.service';
import { OrderService } from '../../services/order.service';

import { OrderSplitter } from './order-splitter';

const DEFAULT_CHANNEL_ID = 1;
const SELLER_CHANNEL_ID = 2;

const defaultChannel = new Channel({ id: DEFAULT_CHANNEL_ID, code: '__default_channel__' });
const sellerChannel = new Channel({ id: SELLER_CHANNEL_ID, code: 'seller' });

/**
 * Stands in for a TypeORM Repository. `save` assigns an incrementing id to new entities and
 * returns the entity, so that the saved seller Order and its duplicated lines can be inspected.
 * The `relation().add()` chain records what was linked to the aggregate Order.
 */
function createFakeRepository(prefix: string) {
    let nextId = 1;
    const saved: any[] = [];
    const relationAdds: Array<{ relation: string; of: any; added: any }> = [];
    const repo = {
        saved,
        relationAdds,
        save: vi.fn(async (entity: any) => {
            if (entity.id == null) {
                entity.id = `${prefix}-${nextId++}`;
            }
            saved.push(entity);
            return entity;
        }),
        createQueryBuilder: () => ({
            relation: (relation: string) => ({
                of: (of: any) => ({
                    add: async (added: any) => {
                        relationAdds.push({ relation, of, added });
                    },
                }),
            }),
        }),
    };
    return repo;
}

describe('OrderSplitter', () => {
    let orderSplitter: OrderSplitter;
    let mockConfigService: MockConfigService;
    let orderRepo: ReturnType<typeof createFakeRepository>;
    let orderLineRepo: ReturnType<typeof createFakeRepository>;
    let shippingLineRepo: ReturnType<typeof createFakeRepository>;
    let channelService: { getDefaultChannel: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
    let orderService: { applyPriceAdjustments: ReturnType<typeof vi.fn> };
    let orderSellerStrategy: {
        splitOrder: ReturnType<typeof vi.fn>;
        afterSellerOrdersCreated: ReturnType<typeof vi.fn>;
    };
    const ctx = RequestContext.empty();

    beforeEach(async () => {
        orderRepo = createFakeRepository('order');
        orderLineRepo = createFakeRepository('line');
        shippingLineRepo = createFakeRepository('shipping');
        const repositories = new Map<any, any>([
            [Order, orderRepo],
            [OrderLine, orderLineRepo],
            [ShippingLine, shippingLineRepo],
        ]);
        const connection = {
            getRepository: vi.fn((_ctx: RequestContext, entity: any) => repositories.get(entity)),
        };
        channelService = {
            getDefaultChannel: vi.fn().mockResolvedValue(defaultChannel),
            findOne: vi.fn(async (_ctx: RequestContext, id: any) =>
                id === SELLER_CHANNEL_ID
                    ? sellerChannel
                    : id === DEFAULT_CHANNEL_ID
                      ? defaultChannel
                      : undefined,
            ),
        };
        orderService = {
            applyPriceAdjustments: vi.fn(async (_ctx: RequestContext, order: Order) => order),
        };
        orderSellerStrategy = {
            splitOrder: vi.fn().mockResolvedValue([]),
            afterSellerOrdersCreated: vi.fn().mockResolvedValue(undefined),
        };

        const module = await Test.createTestingModule({
            providers: [
                OrderSplitter,
                { provide: ConfigService, useClass: MockConfigService },
                { provide: TransactionalConnection, useValue: connection },
                { provide: ChannelService, useValue: channelService },
                { provide: OrderService, useValue: orderService },
            ],
        }).compile();
        mockConfigService = module.get<ConfigService, MockConfigService>(ConfigService);
        mockConfigService.orderOptions = {
            orderSellerStrategy: orderSellerStrategy as unknown as OrderSellerStrategy,
            orderCodeStrategy: { generate: vi.fn().mockReturnValue('SELLER-CODE') },
        };
        orderSplitter = module.get(OrderSplitter);
    });

    function createAggregateOrder(): Order {
        const shippingLine = new ShippingLine({
            id: 10,
            shippingMethodId: 55,
            listPrice: 500,
            listPriceIncludesTax: true,
            adjustments: [],
            taxLines: [{ taxRate: 20, description: 'tax' }],
        });
        const line = new OrderLine({
            id: 20,
            quantity: 3,
            orderPlacedQuantity: 3,
            productVariant: new ProductVariant({ id: 100 }),
            productVariantId: 100,
            listPrice: 1000,
            listPriceIncludesTax: true,
            adjustments: [],
            taxLines: [],
            shippingLineId: shippingLine.id,
            sellerChannelId: SELLER_CHANNEL_ID,
        });
        return new Order({
            id: 1,
            code: 'AGGREGATE',
            type: OrderType.Regular,
            customer: new Customer({ id: 7 }),
            lines: [line],
            shippingLines: [shippingLine],
            couponCodes: ['SAVE10'],
            currencyCode: CurrencyCode.USD,
            shippingAddress: { streetLine1: 'Ship St' },
            billingAddress: { streetLine1: 'Bill St' },
            sellerOrders: [],
        });
    }

    function splitInto(order: Order, channelId = SELLER_CHANNEL_ID): SplitOrderContents[] {
        return [
            {
                channelId,
                state: 'ArrangingPayment',
                lines: order.lines,
                shippingLines: order.shippingLines,
            },
        ];
    }

    describe('when no split is needed', () => {
        it('returns an empty array when the strategy has no splitOrder method', async () => {
            mockConfigService.orderOptions.orderSellerStrategy = {} as OrderSellerStrategy;
            const order = createAggregateOrder();

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(order.type).toBe(OrderType.Regular);
        });

        it('returns an empty array and saves nothing when splitOrder returns no partial orders', async () => {
            const order = createAggregateOrder();

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(order.type).toBe(OrderType.Regular);
            expect(orderRepo.save).not.toHaveBeenCalled();
            expect(channelService.getDefaultChannel).not.toHaveBeenCalled();
            expect(orderSellerStrategy.afterSellerOrdersCreated).not.toHaveBeenCalled();
        });

        it('passes the ctx and order to the strategy', async () => {
            const order = createAggregateOrder();

            await orderSplitter.createSellerOrders(ctx, order);

            expect(orderSellerStrategy.splitOrder).toHaveBeenCalledWith(ctx, order);
        });
    });

    describe('when the order is split', () => {
        it('marks the original order as an Aggregate order', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            expect(order.type).toBe(OrderType.Aggregate);
        });

        it('creates a Seller order copying the aggregate order data', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder).toBeInstanceOf(Order);
            expect(sellerOrder).not.toBe(order);
            expect(sellerOrder.type).toBe(OrderType.Seller);
            expect(sellerOrder.aggregateOrderId).toBe(order.id);
            expect(sellerOrder.code).toBe('SELLER-CODE');
            expect(sellerOrder.active).toBe(false);
            expect(sellerOrder.orderPlacedAt).toBeInstanceOf(Date);
            expect(sellerOrder.state).toBe('ArrangingPayment');
            expect(sellerOrder.customer).toBe(order.customer);
            expect(sellerOrder.couponCodes).toEqual(['SAVE10']);
            expect(sellerOrder.currencyCode).toBe(CurrencyCode.USD);
            expect(sellerOrder.shippingAddress).toEqual({ streetLine1: 'Ship St' });
            expect(sellerOrder.billingAddress).toEqual({ streetLine1: 'Bill St' });
            expect(sellerOrder.subTotal).toBe(0);
            expect(sellerOrder.subTotalWithTax).toBe(0);
            expect(sellerOrder.surcharges).toEqual([]);
            expect(sellerOrder.modifications).toEqual([]);
        });

        it('assigns the seller order to the seller channel and the default channel', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order, SELLER_CHANNEL_ID));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder.channels.map(c => c.id)).toEqual([SELLER_CHANNEL_ID, DEFAULT_CHANNEL_ID]);
            expect(sellerOrder.channels[1]).toBe(defaultChannel);
        });

        it('assigns the seller order to only the default channel when that is the seller channel', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order, DEFAULT_CHANNEL_ID));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder.channels).toEqual([defaultChannel]);
        });

        it('duplicates the order lines as new entities with the pricing data copied', async () => {
            const order = createAggregateOrder();
            const [originalLine] = order.lines;
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder.lines).toHaveLength(1);
            const [newLine] = sellerOrder.lines;
            expect(newLine).toBeInstanceOf(OrderLine);
            expect(newLine).not.toBe(originalLine);
            expect(newLine.id).not.toBe(originalLine.id);
            expect(newLine.quantity).toBe(3);
            expect(newLine.orderPlacedQuantity).toBe(3);
            expect(newLine.productVariantId).toBe(100);
            expect(newLine.productVariant).toBe(originalLine.productVariant);
            expect(newLine.listPrice).toBe(1000);
            expect(newLine.listPriceIncludesTax).toBe(true);
            expect(newLine.sellerChannelId).toBe(SELLER_CHANNEL_ID);
            expect(order.lines[0]).toBe(originalLine);
        });

        it('duplicates the shipping lines and re-points the new lines at the new shipping line', async () => {
            const order = createAggregateOrder();
            const [originalShippingLine] = order.shippingLines;
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder.shippingLines).toHaveLength(1);
            const [newShippingLine] = sellerOrder.shippingLines;
            expect(newShippingLine).toBeInstanceOf(ShippingLine);
            expect(newShippingLine).not.toBe(originalShippingLine);
            expect(newShippingLine.shippingMethodId).toBe(55);
            expect(newShippingLine.listPrice).toBe(500);
            expect(newShippingLine.taxLines).toEqual([{ taxRate: 20, description: 'tax' }]);
            expect(sellerOrder.lines[0].shippingLineId).toBe(newShippingLine.id);
            expect(originalShippingLine.id).toBe(10);
            // the re-pointed line is persisted a second time
            expect(orderLineRepo.save).toHaveBeenCalledTimes(2);
            expect(orderLineRepo.save).toHaveBeenLastCalledWith(sellerOrder.lines[0]);
        });

        it('leaves lines that belong to a different shipping line untouched', async () => {
            const order = createAggregateOrder();
            order.lines[0].shippingLineId = 999;
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrder = orderRepo.saved[0] as Order;
            expect(sellerOrder.lines[0].shippingLineId).toBe(999);
            expect(orderLineRepo.save).toHaveBeenCalledTimes(1);
        });

        it('links each seller order to the aggregate order via the sellerOrders relation', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            expect(orderRepo.relationAdds).toEqual([
                { relation: 'sellerOrders', of: order, added: orderRepo.saved[0] },
            ]);
        });

        it('applies price adjustments in a context scoped to the seller channel', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            expect(orderService.applyPriceAdjustments).toHaveBeenCalledTimes(1);
            const [sellerCtx, sellerOrder, promotions, updatedLines, options] =
                orderService.applyPriceAdjustments.mock.calls[0];
            expect(sellerCtx).not.toBe(ctx);
            expect(sellerCtx).toBeInstanceOf(RequestContext);
            expect(sellerCtx.channel).toBe(sellerChannel);
            expect(sellerCtx.apiType).toBe(ctx.apiType);
            expect(sellerCtx.languageCode).toBe(ctx.languageCode);
            expect(sellerOrder).toBe(orderRepo.saved[0]);
            expect(promotions).toBeUndefined();
            expect(updatedLines).toBeUndefined();
            expect(options).toEqual({ recalculateShipping: false, recalculateShippingPromotions: true });
        });

        it('creates one seller order per partial order', async () => {
            const order = createAggregateOrder();
            const secondLine = new OrderLine({
                id: 21,
                quantity: 1,
                productVariantId: 101,
                productVariant: new ProductVariant({ id: 101 }),
                adjustments: [],
                taxLines: [],
            });
            order.lines.push(secondLine);
            orderSellerStrategy.splitOrder.mockResolvedValue([
                {
                    channelId: SELLER_CHANNEL_ID,
                    state: 'ArrangingPayment',
                    lines: [order.lines[0]],
                    shippingLines: order.shippingLines,
                },
                {
                    channelId: DEFAULT_CHANNEL_ID,
                    state: 'PaymentSettled',
                    lines: [secondLine],
                    shippingLines: [],
                },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            expect(orderRepo.saved).toHaveLength(2);
            const [first, second] = orderRepo.saved as Order[];
            expect(first.lines[0].productVariantId).toBe(100);
            expect(first.state).toBe('ArrangingPayment');
            expect(second.lines[0].productVariantId).toBe(101);
            expect(second.state).toBe('PaymentSettled');
            expect(second.shippingLines).toEqual([]);
            expect(orderRepo.relationAdds.map(r => r.added)).toEqual([first, second]);
            expect(orderService.applyPriceAdjustments).toHaveBeenCalledTimes(2);
        });

        it('invokes afterSellerOrdersCreated with the created seller orders', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await orderSplitter.createSellerOrders(ctx, order);

            expect(orderSellerStrategy.afterSellerOrdersCreated).toHaveBeenCalledWith(ctx, order, [
                orderRepo.saved[0],
            ]);
        });

        it('tolerates a strategy without afterSellerOrdersCreated', async () => {
            const order = createAggregateOrder();
            mockConfigService.orderOptions.orderSellerStrategy = {
                splitOrder: orderSellerStrategy.splitOrder,
            } as unknown as OrderSellerStrategy;
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            await expect(orderSplitter.createSellerOrders(ctx, order)).resolves.toBeDefined();
            expect(orderRepo.saved).toHaveLength(1);
        });

        it('returns the sellerOrders relation of the aggregate order', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order));

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toBe(order.sellerOrders);
        });

        it('throws when the seller channel cannot be loaded', async () => {
            const order = createAggregateOrder();
            orderSellerStrategy.splitOrder.mockResolvedValue(splitInto(order, 999));

            await expect(orderSplitter.createSellerOrders(ctx, order)).rejects.toBeInstanceOf(
                InternalServerError,
            );
            expect(orderService.applyPriceAdjustments).not.toHaveBeenCalled();
        });
    });
});
