import { Test } from '@nestjs/testing';
import { LanguageCode } from '@vendure/common/lib/generated-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../../api/common/request-context';
import { InternalServerError } from '../../../common/error/errors';
import { ConfigService } from '../../../config/config.service';
import { MockConfigService } from '../../../config/config.service.mock';
import { TransactionalConnection } from '../../../connection/transactional-connection';
import { Channel } from '../../../entity/channel/channel.entity';
import { OrderLine } from '../../../entity/order-line/order-line.entity';
import { Order } from '../../../entity/order/order.entity';
import { ProductVariant } from '../../../entity/product-variant/product-variant.entity';
import { ShippingLine } from '../../../entity/shipping-line/shipping-line.entity';
import { TaxCategory } from '../../../entity/tax-category/tax-category.entity';
import { createOrderFromLines } from '../../../testing/order-test-utils';
import { ChannelService } from '../../services/channel.service';
import { OrderService } from '../../services/order.service';

import { OrderSplitter } from './order-splitter';

describe('OrderSplitter', () => {
    let orderSplitter: OrderSplitter;
    let configService: MockConfigService;
    let save: ReturnType<typeof vi.fn>;
    let channelService: { getDefaultChannel: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
    let orderService: { applyPriceAdjustments: ReturnType<typeof vi.fn> };
    let splitOrder: ReturnType<typeof vi.fn>;
    const ctx = RequestContext.empty();

    beforeEach(async () => {
        save = vi.fn().mockImplementation((entity: any) => Promise.resolve(entity));
        const connection = { getRepository: () => ({ save }) } as unknown as TransactionalConnection;
        channelService = { getDefaultChannel: vi.fn(), findOne: vi.fn() };
        orderService = { applyPriceAdjustments: vi.fn() };
        splitOrder = vi.fn();
        const module = await Test.createTestingModule({
            providers: [
                OrderSplitter,
                { provide: ConfigService, useClass: MockConfigService },
                { provide: TransactionalConnection, useValue: connection },
                { provide: ChannelService, useValue: channelService },
                { provide: OrderService, useValue: orderService },
            ],
        }).compile();
        configService = module.get<ConfigService, MockConfigService>(ConfigService);
        configService.orderOptions = {
            orderSellerStrategy: { splitOrder } as any,
        };
        orderSplitter = module.get(OrderSplitter);
    });

    describe('createSellerOrders()', () => {
        it('returns an empty array when the strategy does not split the order', async () => {
            splitOrder.mockResolvedValue(undefined);
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(splitOrder).toHaveBeenCalledWith(ctx, order);
            expect(order.type).toBeUndefined();
            expect(channelService.getDefaultChannel).not.toHaveBeenCalled();
            expect(save).not.toHaveBeenCalled();
        });

        it('returns an empty array when the strategy returns no partial orders', async () => {
            splitOrder.mockResolvedValue([]);
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(order.type).toBeUndefined();
            expect(save).not.toHaveBeenCalled();
        });

        it('does nothing when the strategy does not implement splitOrder', async () => {
            configService.orderOptions = { orderSellerStrategy: {} as any };
            const order = createOrderFromLines([{ lineId: 1, quantity: 1, productVariantId: 100 }]);

            const result = await orderSplitter.createSellerOrders(ctx, order);

            expect(result).toEqual([]);
            expect(save).not.toHaveBeenCalled();
        });
    });

    describe('duplicateOrderLine()', () => {
        it('saves a new OrderLine carrying over the pricing, variant and quantity fields only', async () => {
            const productVariant = new ProductVariant({ id: 100 });
            const taxCategory = new TaxCategory({ id: 5 });
            const line = new OrderLine({
                id: 42,
                order: new Order({ id: 1 }),
                quantity: 3,
                orderPlacedQuantity: 3,
                productVariant,
                productVariantId: 100,
                taxCategory,
                taxCategoryId: 5,
                shippingLineId: 7,
                sellerChannelId: 9,
                initialListPrice: 1000,
                listPrice: 900,
                listPriceIncludesTax: true,
                adjustments: [
                    { adjustmentSource: 'promo', type: 'PROMOTION' as any, description: '', amount: -100 },
                ],
                taxLines: [{ taxRate: 20, description: 'std' }],
                customFields: { foo: 'bar' },
            });

            const result = await (orderSplitter as any).duplicateOrderLine(ctx, line);

            expect(save).toHaveBeenCalledTimes(1);
            const saved: OrderLine = save.mock.calls[0][0];
            expect(saved).toBeInstanceOf(OrderLine);
            expect(saved).not.toBe(line);
            expect(result).toBe(saved);
            expect(saved.id).toBeUndefined();
            expect(saved.order).toBeUndefined();
            expect(saved.quantity).toBe(3);
            expect(saved.orderPlacedQuantity).toBe(3);
            expect(saved.productVariant).toBe(productVariant);
            expect(saved.productVariantId).toBe(100);
            expect(saved.taxCategory).toBe(taxCategory);
            expect(saved.taxCategoryId).toBe(5);
            expect(saved.shippingLineId).toBe(7);
            expect(saved.sellerChannelId).toBe(9);
            expect(saved.initialListPrice).toBe(1000);
            expect(saved.listPrice).toBe(900);
            expect(saved.listPriceIncludesTax).toBe(true);
            expect(saved.adjustments).toEqual(line.adjustments);
            expect(saved.taxLines).toEqual(line.taxLines);
            expect(saved.customFields).toEqual({ foo: 'bar' });
        });
    });

    describe('duplicateShippingLine()', () => {
        it('saves a new ShippingLine carrying over the method, prices and adjustments only', async () => {
            const order = new Order({ id: 1 });
            const shippingLine = new ShippingLine({
                id: 11,
                shippingMethodId: 3,
                order,
                listPrice: 500,
                listPriceIncludesTax: false,
                adjustments: [
                    { adjustmentSource: 'promo', type: 'PROMOTION' as any, description: '', amount: -50 },
                ],
                taxLines: [{ taxRate: 10, description: 'reduced' }],
            });

            const result = await (orderSplitter as any).duplicateShippingLine(ctx, shippingLine);

            expect(save).toHaveBeenCalledTimes(1);
            const saved: ShippingLine = save.mock.calls[0][0];
            expect(saved).toBeInstanceOf(ShippingLine);
            expect(saved).not.toBe(shippingLine);
            expect(result).toBe(saved);
            expect(saved.id).toBeUndefined();
            expect(saved.shippingMethodId).toBe(3);
            expect(saved.order).toBe(order);
            expect(saved.listPrice).toBe(500);
            expect(saved.listPriceIncludesTax).toBe(false);
            expect(saved.adjustments).toEqual(shippingLine.adjustments);
            expect(saved.taxLines).toEqual(shippingLine.taxLines);
        });
    });

    describe('createSellerChannelContext()', () => {
        it('re-scopes a copy of the context to the seller channel, keeping language and currency', async () => {
            const sellerChannel = new Channel({
                id: 2,
                code: 'seller',
                defaultLanguageCode: LanguageCode.de,
            });
            channelService.findOne.mockResolvedValue(sellerChannel);
            const aggregateCtx = new RequestContext({
                apiType: 'shop',
                channel: new Channel({ id: 1, code: 'default', defaultLanguageCode: LanguageCode.en }),
                languageCode: LanguageCode.fr,
                currencyCode: 'GBP' as any,
                isAuthorized: true,
                authorizedAsOwnerOnly: true,
            });

            const sellerCtx: RequestContext = await (orderSplitter as any).createSellerChannelContext(
                aggregateCtx,
                2,
            );

            expect(channelService.findOne).toHaveBeenCalledWith(aggregateCtx, 2);
            expect(sellerCtx).not.toBe(aggregateCtx);
            expect(sellerCtx.channel).toBe(sellerChannel);
            expect(sellerCtx.channelId).toBe(2);
            expect(sellerCtx.languageCode).toBe(LanguageCode.fr);
            expect(sellerCtx.currencyCode).toBe('GBP');
            expect(sellerCtx.apiType).toBe('shop');
            expect(aggregateCtx.channelId).toBe(1);
        });

        it('throws an InternalServerError when the seller channel cannot be loaded', async () => {
            channelService.findOne.mockResolvedValue(undefined);

            await expect((orderSplitter as any).createSellerChannelContext(ctx, 99)).rejects.toBeInstanceOf(
                InternalServerError,
            );
        });
    });
});
