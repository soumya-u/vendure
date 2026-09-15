import { Test } from '@nestjs/testing';
import { CurrencyCode, LanguageCode, OrderType } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { InternalServerError } from '../../../common/error/errors';
import { ConfigService } from '../../../config/config.service';
import { MockConfigService } from '../../../config/config.service.mock';
import { SplitOrderContents } from '../../../config/order/order-seller-strategy';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { Customer } from '../../../entity/customer/customer.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { Order } from '../../../entity/order/order.entity';
import { ShippingLine } from '../../../entity/shipping-line/shipping-line.entity';
import { ChannelService } from '../../services/channel.service';
import { OrderService } from '../../services/order.service';

import { OrderSplitter } from './order-splitter';

const DEFAULT_CHANNEL_ID = 1;
const SELLER_CHANNEL_ID = 2;

const defaultChannel = new Channel({
    id: DEFAULT_CHANNEL_ID,
    code: '__default_channel__',
    defaultLanguageCode: LanguageCode.en,
    defaultCurrencyCode: CurrencyCode.USD,
});
const sellerChannel = new Channel({
    id: SELLER_CHANNEL_ID,
    code: 'seller',
    defaultLanguageCode: LanguageCode.de,
    defaultCurrencyCode: CurrencyCode.EUR,
});

/**
 * A minimal in-memory stand-in for the repositories reached through
 * `TransactionalConnection.getRepository()`. `save()` assigns an incrementing id and records
 * the saved entity; the `relation().of().add()` chain used to link seller Orders is recorded too.
 */
function createMockConnection() {
    let nextId = 100;
    const saved = new Map<any, any[]>();
    const relationAdds: Array<{ relation: string; of: any; added: any }> = [];
    const repos = new Map<any, any>();
    const getRepository = vi.fn((ctx: RequestContext, entity: any) => {
        if (!repos.has(entity)) {
            saved.set(entity, []);
            repos.set(entity, {
                save: vi.fn(async (e: any) => {
                    if (e.id == null) {
                        e.id = nextId++;
                    }
                    saved.get(entity)?.push(e);
                    return e;
                }),
                createQueryBuilder: vi.fn(() => ({
                    relation: (relation: string) => ({
                        of: (of: any) => ({
                            add: async (added: any) => {
                                relationAdds.push({ relation, of, added });
                            },
                        }),
                    }),
                })),
            });
        }
        return repos.get(entity);
    });
    return {
        connection: { getRepository } as unknown as TransactionalConnection,
        getRepository,
        savedOf: <T>(entity: new (...args: any[]) => T): T[] => saved.get(entity) ?? [],
        relationAdds,
    };
}

function createAggregateOrder(): Order {
    const shippingLine = new ShippingLine({
        id: 10,
        shippingMethodId: 55,
        listPrice: 500,
        listPriceIncludesTax: true,
        adjustments: [
            { type: 'PROMOTION' as any, description: 'ship promo', amount: -100, adjustmentSource: 'p' },
        ],
        taxLines: [{ taxRate: 20, description: 'VAT' }],
    });
    const lines = [
        new OrderLine({
            id: 1,
            quantity: 2,
            productVariantId: 11,
            taxCategoryId: 1,
            shippingLineId: shippingLine.id,
            sellerChannelId: SELLER_CHANNEL_ID,
            listPrice: 1000,
            listPriceIncludesTax: true,
            initialListPrice: 1000,
            adjustments: [],
            taxLines: [],
            orderPlacedQuantity: 2,
            customFields: { note: 'gift' },
        }),
        new OrderLine({
            id: 2,
            quantity: 1,
            productVariantId: 12,
            taxCategoryId: 1,
            shippingLineId: shippingLine.id,
            sellerChannelId: DEFAULT_CHANNEL_ID,
            listPrice: 300,
            listPriceIncludesTax: true,
            adjustments: [],
            taxLines: [],
            orderPlacedQuantity: 1,
        }),
    ];
    return new Order({
        id: 7,
        code: 'AGG',
        type: OrderType.Regular,
        currencyCode: CurrencyCode.USD,
        couponCodes: ['SAVE10'],
        customer: new Customer({ id: 3 }),
        shippingAddress: { streetLine1: 'ship st' },
        billingAddress: { streetLine1: 'bill st' },
        lines,
        shippingLines: [shippingLine],
        sellerOrders: [],
    });
}

describe('OrderSplitter', () => {
    let orderSplitter: OrderSplitter;
    let configService: MockConfigService;
    let mockConnection: ReturnType<typeof createMockConnection>;
    let channelService: { getDefaultChannel: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
    let orderService: { applyPriceAdjustments: ReturnType<typeof vi.fn> };
    let ctx: RequestContext;

    beforeEach(async () => {
        mockConnection = createMockConnection();
        channelService = {
            getDefaultChannel: vi.fn().mockResolvedValue(defaultChannel),
            findOne: vi.fn(async (_ctx: RequestContext, id: any) =>
                [defaultChannel, sellerChannel].find(c => c.id === id),
            ),
        };
        orderService = { applyPriceAdjustments: vi.fn(async (_ctx: RequestContext, order: Order) => order) };
        const module = await Test.createTestingModule({
            providers: [
                OrderSplitter,
                { provide: ConfigService, useClass: MockConfigService },
                { provide: TransactionalConnection, useValue: mockConnection.connection },
                { provide: ChannelService, useValue: channelService },
                { provide: OrderService, useValue: orderService },
            ],
        }).compile();
        configService = module.get<ConfigService, MockConfigService>(ConfigService);
        configService.orderOptions = {
            orderSellerStrategy: {},
            orderCodeStrategy: { generate: vi.fn().mockResolvedValue('SELLER-CODE') } as any,
        };
        orderSplitter = module.get(OrderSplitter);
        ctx = new RequestContext({
            apiType: 'shop',
            channel: defaultChannel,
            authorizedAsOwnerOnly: true,
            isAuthorized: true,
            languageCode: LanguageCode.fr,
            currencyCode: CurrencyCode.USD,
            session: {} as any,
        });
    });

    function splitInto(partials: SplitOrderContents[] | undefined) {
        const splitOrder = vi.fn().mockResolvedValue(partials);
        configService.orderOptions.orderSellerStrategy = { splitOrder };
        return splitOrder;
    }

    describe('no split needed', () => {
        it('returns [] when the strategy has no splitOrder()', async () => {
            const order = createAggregateOrder();

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(order.type).toBe(OrderType.Regular);
            expect(mockConnection.getRepository).not.toHaveBeenCalled();
        });

        it('returns [] when splitOrder() returns an empty array', async () => {
            const order = createAggregateOrder();
            const splitOrder = splitInto([]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(splitOrder).toHaveBeenCalledWith(ctx, order);
            expect(result).toEqual([]);
            expect(order.type).toBe(OrderType.Regular);
            expect(channelService.getDefaultChannel).not.toHaveBeenCalled();
        });

        it('returns [] when splitOrder() returns undefined', async () => {
            const order = createAggregateOrder();
            splitInto(undefined);

            await expect(orderSplitter.createSellerOrders(ctx, order)).resolves.toEqual([]);
        });
    });

    describe('splitting into seller orders', () => {
        it('marks the original Order as an Aggregate and creates one Seller Order per partial', async () => {
            const order = createAggregateOrder();
            splitInto([
                {
                    channelId: SELLER_CHANNEL_ID,
                    state: 'ArrangingPayment',
                    lines: [order.lines[0]],
                    shippingLines: [],
                },
                {
                    channelId: DEFAULT_CHANNEL_ID,
                    state: 'PaymentSettled',
                    lines: [order.lines[1]],
                    shippingLines: [],
                },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            expect(order.type).toBe(OrderType.Aggregate);
            const sellerOrders = mockConnection.savedOf(Order);
            expect(sellerOrders).toHaveLength(2);
            expect(sellerOrders.map(o => o.state)).toEqual(['ArrangingPayment', 'PaymentSettled']);
            for (const sellerOrder of sellerOrders) {
                expect(sellerOrder.type).toBe(OrderType.Seller);
                expect(sellerOrder.aggregateOrderId).toBe(order.id);
                expect(sellerOrder.code).toBe('SELLER-CODE');
                expect(sellerOrder.active).toBe(false);
                expect(sellerOrder.orderPlacedAt).toBeInstanceOf(Date);
                expect(sellerOrder.customer).toBe(order.customer);
                expect(sellerOrder.couponCodes).toEqual(['SAVE10']);
                expect(sellerOrder.shippingAddress).toBe(order.shippingAddress);
                expect(sellerOrder.billingAddress).toBe(order.billingAddress);
                expect(sellerOrder.currencyCode).toBe(CurrencyCode.USD);
                expect(sellerOrder.surcharges).toEqual([]);
                expect(sellerOrder.modifications).toEqual([]);
                expect(sellerOrder.subTotal).toBe(0);
                expect(sellerOrder.subTotalWithTax).toBe(0);
            }
        });

        it('generates a fresh code for each seller order using the OrderCodeStrategy', async () => {
            const order = createAggregateOrder();
            const generate = vi.fn().mockResolvedValueOnce('CODE-A').mockResolvedValueOnce('CODE-B');
            configService.orderOptions.orderCodeStrategy = { generate } as any;
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
                { channelId: DEFAULT_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            expect(generate).toHaveBeenCalledTimes(2);
            expect(generate).toHaveBeenCalledWith(ctx);
            expect(mockConnection.savedOf(Order).map(o => o.code)).toEqual(['CODE-A', 'CODE-B']);
        });

        it('assigns a seller Channel plus the default Channel, or only the default Channel', async () => {
            const order = createAggregateOrder();
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
                { channelId: DEFAULT_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerChannelOrder, defaultChannelOrder] = mockConnection.savedOf(Order);
            expect(sellerChannelOrder.channels.map(c => c.id)).toEqual([
                SELLER_CHANNEL_ID,
                DEFAULT_CHANNEL_ID,
            ]);
            expect(sellerChannelOrder.channels[1]).toBe(defaultChannel);
            expect(defaultChannelOrder.channels).toEqual([defaultChannel]);
        });

        it('duplicates OrderLines rather than moving them, copying only pricing & product data', async () => {
            const order = createAggregateOrder();
            const [sourceLine] = order.lines;
            splitInto([
                {
                    channelId: SELLER_CHANNEL_ID,
                    state: 'PaymentSettled',
                    lines: [sourceLine],
                    shippingLines: [],
                },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const savedLines = mockConnection.savedOf(OrderLine);
            expect(savedLines).toHaveLength(1);
            const [newLine] = savedLines;
            expect(newLine).not.toBe(sourceLine);
            expect(newLine.id).not.toBe(sourceLine.id);
            expect(newLine).toMatchObject({
                quantity: 2,
                productVariantId: 11,
                taxCategoryId: 1,
                shippingLineId: sourceLine.shippingLineId,
                sellerChannelId: SELLER_CHANNEL_ID,
                listPrice: 1000,
                listPriceIncludesTax: true,
                initialListPrice: 1000,
                orderPlacedQuantity: 2,
                customFields: { note: 'gift' },
            });
            expect(mockConnection.savedOf(Order)[0].lines).toEqual([newLine]);
            expect(order.lines[0]).toBe(sourceLine);
        });

        it('duplicates ShippingLines and re-points the duplicated OrderLines at the new ShippingLine', async () => {
            const order = createAggregateOrder();
            const [shippingLine] = order.shippingLines;
            splitInto([
                {
                    channelId: SELLER_CHANNEL_ID,
                    state: 'PaymentSettled',
                    lines: [order.lines[0], order.lines[1]],
                    shippingLines: [shippingLine],
                },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const savedShippingLines = mockConnection.savedOf(ShippingLine);
            expect(savedShippingLines).toHaveLength(1);
            const [newShippingLine] = savedShippingLines;
            expect(newShippingLine.id).not.toBe(shippingLine.id);
            expect(newShippingLine).toMatchObject({
                shippingMethodId: 55,
                listPrice: 500,
                listPriceIncludesTax: true,
                adjustments: shippingLine.adjustments,
                taxLines: shippingLine.taxLines,
            });
            const sellerOrder = mockConnection.savedOf(Order)[0];
            expect(sellerOrder.shippingLines).toEqual([newShippingLine]);
            for (const line of sellerOrder.lines) {
                expect(line.shippingLineId).toBe(newShippingLine.id);
            }
            // each duplicated line is saved once on creation and once more after re-pointing
            expect(mockConnection.getRepository(ctx, OrderLine).save).toHaveBeenCalledTimes(4);
            // the aggregate Order's lines are untouched
            expect(order.lines.every(l => l.shippingLineId === shippingLine.id)).toBe(true);
        });

        it('leaves OrderLines which belong to a different ShippingLine untouched', async () => {
            const order = createAggregateOrder();
            const otherShippingLine = new ShippingLine({
                id: 99,
                shippingMethodId: 1,
                adjustments: [],
                taxLines: [],
            });
            order.lines[1].shippingLineId = otherShippingLine.id;
            splitInto([
                {
                    channelId: SELLER_CHANNEL_ID,
                    state: 'PaymentSettled',
                    lines: [order.lines[0], order.lines[1]],
                    shippingLines: [order.shippingLines[0]],
                },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const [newShippingLine] = mockConnection.savedOf(ShippingLine);
            const [lineA, lineB] = mockConnection.savedOf(OrderLine);
            expect(lineA.shippingLineId).toBe(newShippingLine.id);
            expect(lineB.shippingLineId).toBe(otherShippingLine.id);
        });

        it('links each seller Order to the aggregate Order via the sellerOrders relation', async () => {
            const order = createAggregateOrder();
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
                { channelId: DEFAULT_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const sellerOrders = mockConnection.savedOf(Order);
            expect(mockConnection.relationAdds).toEqual([
                { relation: 'sellerOrders', of: order, added: sellerOrders[0] },
                { relation: 'sellerOrders', of: order, added: sellerOrders[1] },
            ]);
        });

        it('applies price adjustments in a context scoped to the seller Channel', async () => {
            const order = createAggregateOrder();
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            expect(channelService.findOne).toHaveBeenCalledWith(ctx, SELLER_CHANNEL_ID);
            expect(orderService.applyPriceAdjustments).toHaveBeenCalledTimes(1);
            const [sellerCtx, sellerOrder, promotions, updatedLines, options] =
                orderService.applyPriceAdjustments.mock.calls[0];
            expect(sellerOrder).toBe(mockConnection.savedOf(Order)[0]);
            expect(promotions).toBeUndefined();
            expect(updatedLines).toBeUndefined();
            expect(options).toEqual({ recalculateShipping: false, recalculateShippingPromotions: true });
            expect(sellerCtx).not.toBe(ctx);
            expect(sellerCtx.channel).toBe(sellerChannel);
            expect(sellerCtx.channelId).toBe(SELLER_CHANNEL_ID);
        });

        it('keeps the customer language, currency and api type on the seller context', async () => {
            const order = createAggregateOrder();
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerCtx] = orderService.applyPriceAdjustments.mock.calls[0] as [RequestContext];
            expect(sellerCtx.languageCode).toBe(LanguageCode.fr);
            expect(sellerCtx.currencyCode).toBe(CurrencyCode.USD);
            expect(sellerCtx.apiType).toBe('shop');
            expect(sellerCtx.session).toBe(ctx.session);
            // the original context is not mutated
            expect(ctx.channel).toBe(defaultChannel);
        });

        it('throws an InternalServerError when the seller Channel cannot be loaded', async () => {
            const order = createAggregateOrder();
            splitInto([{ channelId: 999, state: 'PaymentSettled', lines: [], shippingLines: [] }]);

            await expect(orderSplitter.createSellerOrders(ctx, order)).rejects.toBeInstanceOf(
                InternalServerError,
            );
            expect(orderService.applyPriceAdjustments).not.toHaveBeenCalled();
        });

        it('invokes afterSellerOrdersCreated() with the created seller orders', async () => {
            const order = createAggregateOrder();
            const afterSellerOrdersCreated = vi.fn().mockResolvedValue(undefined);
            const splitOrder = vi.fn().mockResolvedValue([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
                { channelId: DEFAULT_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);
            configService.orderOptions.orderSellerStrategy = { splitOrder, afterSellerOrdersCreated };

            await orderSplitter.createSellerOrders(ctx, order);

            expect(afterSellerOrdersCreated).toHaveBeenCalledTimes(1);
            const [hookCtx, hookOrder, hookSellerOrders] = afterSellerOrdersCreated.mock.calls[0];
            expect(hookCtx).toBe(ctx);
            expect(hookOrder).toBe(order);
            expect(hookSellerOrders).toEqual(mockConnection.savedOf(Order));
        });

        it('tolerates a strategy without afterSellerOrdersCreated()', async () => {
            const order = createAggregateOrder();
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            await expect(orderSplitter.createSellerOrders(ctx, order)).resolves.not.toThrow();
        });

        it("returns the aggregate Order's sellerOrders relation as loaded on the entity", async () => {
            const order = createAggregateOrder();
            const preloaded = new Order({ id: 50 });
            order.sellerOrders = [preloaded];
            splitInto([
                { channelId: SELLER_CHANNEL_ID, state: 'PaymentSettled', lines: [], shippingLines: [] },
            ]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toBe(order.sellerOrders);
            expect(result).toEqual([preloaded]);
        });
    });
});
