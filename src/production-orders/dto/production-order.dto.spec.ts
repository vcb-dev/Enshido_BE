import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SplitSubTicketsDto } from './production-order.dto';

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
