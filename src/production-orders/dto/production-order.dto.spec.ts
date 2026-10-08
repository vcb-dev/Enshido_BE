import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AssignOrderDto,
  HandoverInfoDto,
  SplitSubTicketsDto,
} from './production-order.dto';

describe('SplitSubTicketsDto', () => {
  it('từ chối lần chia đầu tiên chỉ có một phiếu con', async () => {
    const dto = plainToInstance(SplitSubTicketsDto, {
      tickets: [{ qty: 10, silverWeight: '100' }],
    });

    const errors = await validate(dto);

    expect(
      errors.find((error) => error.property === 'tickets')?.constraints,
    ).toHaveProperty('arrayMinSize');
  });

  it('chấp nhận từ hai phiếu hợp lệ trở lên', async () => {
    const dto = plainToInstance(SplitSubTicketsDto, {
      tickets: [
        { qty: 5, silverWeight: '50' },
        { qty: 5, silverWeight: '50' },
      ],
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});

describe('thông tin giao thợ', () => {
  it('không bắt buộc nhập thời gian giao', async () => {
    await expect(
      validate(plainToInstance(HandoverInfoDto, {})),
    ).resolves.toEqual([]);
  });

  it('nếu client cũ gửi thời gian thì vẫn phải là ISO hợp lệ', async () => {
    const errors = await validate(
      plainToInstance(HandoverInfoDto, { handedAt: 'invalid' }),
    );
    expect(errors.some((error) => error.property === 'handedAt')).toBe(true);
  });

  it('giao phiếu mẹ yêu cầu chọn khâu và thợ', async () => {
    const errors = await validate(plainToInstance(AssignOrderDto, {}));
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['stage', 'craftsmanUserId']),
    );
  });

  it('tự gắn BTP được gửi materials rỗng và không cần thời gian', async () => {
    const dto = plainToInstance(AssignOrderDto, {
      stage: 'FILING',
      craftsmanUserId: '11111111-1111-4111-8111-111111111111',
      handedQty: 4,
      materials: [],
    });
    await expect(validate(dto)).resolves.toEqual([]);
  });
});
