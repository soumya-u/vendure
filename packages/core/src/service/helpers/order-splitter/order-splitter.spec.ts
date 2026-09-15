import { Test } from '@nestjs/testing';
import { CurrencyCode, LanguageCode, OrderType } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { InternalServerError } from '../../../common/error/errors';
import { ConfigService } from '../../../config/config.service';
import { SplitOrderContents } from '../../../config/order/order-seller-strategy';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { Order } from '../../../entity/order/order.entity';
import { ShippingLine } from '../../../entity/shipping-line/shipping-line.entity';
import { ChannelService } from '../../services/channel.service';
import { OrderService } from '../../services/order.service';

import { OrderSplitter } from './order-splitter';

const DEFAULT_CHANNEL_ID = 'T_1';
const SELLER_CHANNEL_ID = 'T_2';

function createChannel(id: ID, code: string): Channel {
    return new Channel({
        id,
        code,
        defaultLanguageCode: LanguageCode.en,
        defaultCurrencyCode: CurrencyCode.USD,
    });
}

const defaultChannel = createChannel(DEFAULT_CHANNEL_ID, '__default_channel__');
const sellerChannel = createChannel(SELLER_CHANNEL_ID, 'seller-channel');

function createCtx(): RequestContext {
    return new RequestContext({
        apiType: 'shop',
        channel: defaultChannel,
        languageCode: LanguageCode.de,
        currencyCode: CurrencyCode.GBP,
        session: { id: 'session-1' } as any,
        isAuthorized: true,
        authorizedAsOwnerOnly: false,
    });
}

function createOrderLine(id: ID, overrides: Partial<OrderLine> = {}): OrderLine {
    return new OrderLine({
        id,
        quantity: 2,
        orderPlacedQuantity: 2,
        productVariantId: `variant-${id as string}`,
        taxCategoryId: 'T_1',
        listPrice: 1000,
        listPriceIncludesTax: true,
        initialListPrice: 1000,
        adjustments: [],
        taxLines: [{ description: 'tax', taxRate: 20 }],
        customFields: {},
        ...overrides,
    } as any);
}

function createShippingLine(id: ID): ShippingLine {
    return new ShippingLine({
        id,
        shippingMethodId: `method-${id as string}`,
        listPrice: 500,
        listPriceIncludesTax: true,
        adjustments: [],
        taxLines: [],
    } as any);
}

function createAggregateOrder(): Order {
    return new Order({
        id: 'T_10',
        type: OrderType.Regular,
        code: 'AGGREGATE_CODE',
        currencyCode: CurrencyCode.GBP,
        couponCodes: ['SUMMER'],
        customer: { id: 'T_5' } as any,
        shippingAddress: { streetLine1: '1 Test St', countryCode: 'GB' },
        billingAddress: { streetLine1: '2 Test St', countryCode: 'GB' },
        lines: [],
        surcharges: [],
        shippingLines: [],
        modifications: [],
    });
}

describe('OrderSplitter', () => {
    let orderSplitter: OrderSplitter;
    let ctx: RequestContext;
    let order: Order;
    let splitOrder: ReturnType<typeof vi.fn>;
    let afterSellerOrdersCreated: ReturnType<typeof vi.fn>;
    let generateCode: ReturnType<typeof vi.fn>;
    let applyPriceAdjustments: ReturnType<typeof vi.fn>;
    let channelFindOne: ReturnType<typeof vi.fn>;
    let relationAdd: ReturnType<typeof vi.fn>;
    let savedOrders: Order[];
    let savedOrderLines: OrderLine[];
    let savedShippingLines: ShippingLine[];
    let getRepository: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        ctx = createCtx();
        order = createAggregateOrder();
        savedOrders = [];
        savedOrderLines = [];
        savedShippingLines = [];
        splitOrder = vi.fn();
        afterSellerOrdersCreated = vi.fn();
        generateCode = vi.fn(async () => `SELLER_CODE_${generateCode.mock.calls.length}`);
        applyPriceAdjustments = vi.fn(async () => undefined);
        channelFindOne = vi.fn(async (_ctx: RequestContext, id: ID) =>
            [defaultChannel, sellerChannel].find(c => c.id === id),
        );
        relationAdd = vi.fn(async () => undefined);

        let nextId = 100;
        const save = (collection: any[]) =>
            vi.fn(async (entity: any) => {
                entity.id = `saved_${nextId++}`;
                collection.push(entity);
                return entity;
            });
        const orderRepository = {
            save: save(savedOrders),
            createQueryBuilder: () => ({
                relation: () => ({
                    of: () => ({ add: relationAdd }),
                }),
            }),
        };
        const orderLineRepository = { save: save(savedOrderLines) };
        const shippingLineRepository = { save: save(savedShippingLines) };
        getRepository = vi.fn((_ctx: RequestContext, entity: any) => {
            switch (entity) {
                case Order:
                    return orderRepository;
                case OrderLine:
                    return orderLineRepository;
                case ShippingLine:
                    return shippingLineRepository;
                default:
                    throw new Error(`No mock repository for ${String(entity)}`);
            }
        });

        const module = await Test.createTestingModule({
            providers: [
                OrderSplitter,
                { provide: TransactionalConnection, useValue: { getRepository } },
                {
                    provide: ConfigService,
                    useValue: {
                        orderOptions: {
                            orderSellerStrategy: { splitOrder, afterSellerOrdersCreated },
                            orderCodeStrategy: { generate: generateCode },
                        },
                    },
                },
                {
                    provide: ChannelService,
                    useValue: {
                        getDefaultChannel: async () => defaultChannel,
                        findOne: channelFindOne,
                    },
                },
                { provide: OrderService, useValue: { applyPriceAdjustments } },
            ],
        }).compile();

        orderSplitter = module.get(OrderSplitter);
    });

    function splitInto(...partials: Array<Partial<SplitOrderContents>>) {
        splitOrder.mockResolvedValue(
            partials.map(partial => ({
                channelId: SELLER_CHANNEL_ID,
                state: 'PaymentSettled',
                lines: [],
                shippingLines: [],
                ...partial,
            })),
        );
    }

    describe('when no split is required', () => {
        it('returns an empty array and persists nothing when the strategy returns no partial orders', async () => {
            splitOrder.mockResolvedValue([]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(getRepository).not.toHaveBeenCalled();
            expect(order.type).toBe(OrderType.Regular);
            expect(afterSellerOrdersCreated).not.toHaveBeenCalled();
        });

        it('returns an empty array when the strategy returns undefined', async () => {
            splitOrder.mockResolvedValue(undefined);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(getRepository).not.toHaveBeenCalled();
        });

        it('returns an empty array when the strategy does not implement splitOrder', async () => {
            const module = await Test.createTestingModule({
                providers: [
                    OrderSplitter,
                    { provide: TransactionalConnection, useValue: { getRepository } },
                    {
                        provide: ConfigService,
                        useValue: {
                            orderOptions: {
                                orderSellerStrategy: {},
                                orderCodeStrategy: { generate: generateCode },
                            },
                        },
                    },
                    { provide: ChannelService, useValue: { getDefaultChannel: async () => defaultChannel } },
                    { provide: OrderService, useValue: { applyPriceAdjustments } },
                ],
            }).compile();

            const result = await module.get(OrderSplitter).createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(getRepository).not.toHaveBeenCalled();
        });
    });

    describe('seller Order creation', () => {
        it('marks the source Order as an aggregate Order', async () => {
            splitInto({});

            await orderSplitter.createSellerOrders(ctx, order);

            expect(order.type).toBe(OrderType.Aggregate);
        });

        it('creates one seller Order per partial order, each with its own generated code', async () => {
            splitInto({ channelId: SELLER_CHANNEL_ID }, { channelId: SELLER_CHANNEL_ID });

            await orderSplitter.createSellerOrders(ctx, order);

            expect(savedOrders.length).toBe(2);
            expect(savedOrders.map(o => o.code)).toEqual(['SELLER_CODE_1', 'SELLER_CODE_2']);
            expect(savedOrders.every(o => o.type === OrderType.Seller)).toBe(true);
        });

        it('links the seller Order to the aggregate Order and marks it as placed and inactive', async () => {
            splitInto({ state: 'ArrangingPayment' });

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerOrder] = savedOrders;
            expect(sellerOrder.aggregateOrderId).toBe(order.id);
            expect(sellerOrder.active).toBe(false);
            expect(sellerOrder.state).toBe('ArrangingPayment');
            expect(sellerOrder.orderPlacedAt).toBeInstanceOf(Date);
        });

        it('copies customer-facing data from the aggregate Order and zeroes the totals', async () => {
            splitInto({});

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerOrder] = savedOrders;
            expect(sellerOrder.customer).toBe(order.customer);
            expect(sellerOrder.couponCodes).toEqual(['SUMMER']);
            expect(sellerOrder.shippingAddress).toEqual(order.shippingAddress);
            expect(sellerOrder.billingAddress).toEqual(order.billingAddress);
            expect(sellerOrder.currencyCode).toBe(CurrencyCode.GBP);
            expect(sellerOrder.subTotal).toBe(0);
            expect(sellerOrder.subTotalWithTax).toBe(0);
            expect(sellerOrder.surcharges).toEqual([]);
            expect(sellerOrder.modifications).toEqual([]);
        });

        it('adds the seller Order to the aggregate Order sellerOrders relation', async () => {
            splitInto({});

            await orderSplitter.createSellerOrders(ctx, order);

            expect(relationAdd).toHaveBeenCalledTimes(1);
            expect(relationAdd).toHaveBeenCalledWith(savedOrders[0]);
        });

        it('passes the created seller Orders to afterSellerOrdersCreated', async () => {
            splitInto({}, {});

            await orderSplitter.createSellerOrders(ctx, order);

            expect(afterSellerOrdersCreated).toHaveBeenCalledWith(ctx, order, savedOrders);
        });

        it('still creates seller Orders when the strategy has no afterSellerOrdersCreated hook', async () => {
            const module = await Test.createTestingModule({
                providers: [
                    OrderSplitter,
                    { provide: TransactionalConnection, useValue: { getRepository } },
                    {
                        provide: ConfigService,
                        useValue: {
                            orderOptions: {
                                orderSellerStrategy: { splitOrder },
                                orderCodeStrategy: { generate: generateCode },
                            },
                        },
                    },
                    {
                        provide: ChannelService,
                        useValue: { getDefaultChannel: async () => defaultChannel, findOne: channelFindOne },
                    },
                    { provide: OrderService, useValue: { applyPriceAdjustments } },
                ],
            }).compile();
            splitInto({});

            await module.get(OrderSplitter).createSellerOrders(ctx, order);

            expect(savedOrders.length).toBe(1);
        });

        it('returns the sellerOrders relation of the aggregate Order', async () => {
            const existing = new Order({ id: 'T_99' });
            order.sellerOrders = [existing];
            splitInto({});

            const result = await orderSplitter.createSellerOrders(ctx, order);

            // The seller Orders are attached via a relation query, which does not update the
            // in-memory `order.sellerOrders`, so the return value reflects whatever was already
            // loaded on the entity rather than the Orders just created.
            expect(result).toEqual([existing]);
        });
    });

    describe('Channel assignment', () => {
        it('assigns the seller Channel alongside the default Channel', async () => {
            splitInto({ channelId: SELLER_CHANNEL_ID });

            await orderSplitter.createSellerOrders(ctx, order);

            expect(savedOrders[0].channels.map(c => c.id)).toEqual([SELLER_CHANNEL_ID, DEFAULT_CHANNEL_ID]);
        });

        it('assigns only the default Channel when the partial order belongs to it', async () => {
            splitInto({ channelId: DEFAULT_CHANNEL_ID });

            await orderSplitter.createSellerOrders(ctx, order);

            expect(savedOrders[0].channels).toEqual([defaultChannel]);
        });
    });

    describe('OrderLine duplication', () => {
        it('copies the price and quantity data onto a new OrderLine', async () => {
            const line = createOrderLine('T_20');
            splitInto({ lines: [line] });

            await orderSplitter.createSellerOrders(ctx, order);

            expect(savedOrderLines.length).toBe(1);
            const [newLine] = savedOrderLines;
            expect(newLine).not.toBe(line);
            expect(newLine.quantity).toBe(line.quantity);
            expect(newLine.orderPlacedQuantity).toBe(line.orderPlacedQuantity);
            expect(newLine.productVariantId).toBe(line.productVariantId);
            expect(newLine.listPrice).toBe(line.listPrice);
            expect(newLine.listPriceIncludesTax).toBe(line.listPriceIncludesTax);
            expect(newLine.initialListPrice).toBe(line.initialListPrice);
            expect(newLine.taxLines).toEqual(line.taxLines);
            expect(savedOrders[0].lines).toEqual(savedOrderLines);
        });

        it('does not carry over the source OrderLine id', async () => {
            const line = createOrderLine('T_20');
            splitInto({ lines: [line] });

            await orderSplitter.createSellerOrders(ctx, order);

            expect(savedOrderLines[0].id).not.toBe('T_20');
        });
    });

    describe('ShippingLine duplication', () => {
        it('duplicates the ShippingLine and repoints the matching OrderLines at the copy', async () => {
            const shippingLine = createShippingLine('T_30');
            const matchingLine = createOrderLine('T_20', { shippingLineId: 'T_30' } as any);
            const otherLine = createOrderLine('T_21', { shippingLineId: 'T_31' } as any);
            splitInto({ lines: [matchingLine, otherLine], shippingLines: [shippingLine] });

            await orderSplitter.createSellerOrders(ctx, order);

            const newShippingLine = savedShippingLines[0];
            expect(newShippingLine.shippingMethodId).toBe(shippingLine.shippingMethodId);
            expect(newShippingLine.listPrice).toBe(shippingLine.listPrice);
            expect(newShippingLine.id).not.toBe('T_30');

            const [newMatchingLine, newOtherLine] = savedOrderLines;
            expect(newMatchingLine.shippingLineId).toBe(newShippingLine.id);
            expect(newOtherLine.shippingLineId).toBe('T_31');
            expect(savedOrders[0].shippingLines).toEqual([newShippingLine]);
        });

        it('re-saves only the OrderLines whose ShippingLine changed', async () => {
            const shippingLine = createShippingLine('T_30');
            const matchingLine = createOrderLine('T_20', { shippingLineId: 'T_30' } as any);
            const otherLine = createOrderLine('T_21', { shippingLineId: 'T_31' } as any);
            splitInto({ lines: [matchingLine, otherLine], shippingLines: [shippingLine] });

            await orderSplitter.createSellerOrders(ctx, order);

            const orderLineRepository = getRepository(ctx, OrderLine);
            // two lines duplicated, plus one re-save for the line which was repointed
            expect(orderLineRepository.save).toHaveBeenCalledTimes(3);
        });
    });

    describe('price adjustments', () => {
        it('applies price adjustments in a context scoped to the seller Channel', async () => {
            splitInto({ channelId: SELLER_CHANNEL_ID });

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerCtx] = applyPriceAdjustments.mock.calls[0];
            expect(sellerCtx).toBeInstanceOf(RequestContext);
            expect(sellerCtx).not.toBe(ctx);
            expect(sellerCtx.channel).toBe(sellerChannel);
        });

        it('keeps the customer language and currency of the original context', async () => {
            splitInto({ channelId: SELLER_CHANNEL_ID });

            await orderSplitter.createSellerOrders(ctx, order);

            const [sellerCtx] = applyPriceAdjustments.mock.calls[0];
            expect(sellerCtx.languageCode).toBe(LanguageCode.de);
            expect(sellerCtx.currencyCode).toBe(CurrencyCode.GBP);
            expect(sellerCtx.session).toBe(ctx.session);
        });

        it('recalculates shipping promotions but not shipping prices', async () => {
            splitInto({});

            await orderSplitter.createSellerOrders(ctx, order);

            expect(applyPriceAdjustments).toHaveBeenCalledWith(
                expect.any(RequestContext),
                savedOrders[0],
                undefined,
                undefined,
                { recalculateShipping: false, recalculateShippingPromotions: true },
            );
        });

        it('throws when the seller Channel cannot be loaded', async () => {
            splitInto({ channelId: 'T_999' });

            await expect(orderSplitter.createSellerOrders(ctx, order)).rejects.toThrow(InternalServerError);
            expect(applyPriceAdjustments).not.toHaveBeenCalled();
        });
    });
});
