import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IntakeOrderStatus, Prisma } from '@prisma/client';
import type { AuthUserPayload } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../uploads/cloudinary.service';
import {
  CreateIntakeCastingSlipDto,
  CastingSlipImageDto,
  ListCastingSlipsQuery,
} from './dto/casting-slip.dto';

const CODE_RETRIES = 8;
const SLIP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSlipCode() {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SLIP_CHARS[Math.floor(Math.random() * SLIP_CHARS.length)];
  }
  return `D${suffix}`;
}

function parseDate(value: string, label: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} không hợp lệ`);
  }
  return date;
}

function parseOptionalDateOnly(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

/** Không có kết quả khớp — dùng với `id IN (...)` */
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';

function isUniqueViolation(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class CastingSlipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async list(query: ListCastingSlipsQuery) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 200);
    const where = await this.buildListWhere(query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.castingSlip.count({ where }),
      this.prisma.castingSlip.findMany({
        where,
        orderBy: [{ slipDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          intake: { select: { code: true, productName: true } },
          images: { orderBy: { sortOrder: 'asc' } },
        },
      }),
    ]);

    return {
      items: rows.map(toListRow),
      total,
      page,
      pageSize,
    };
  }

  async getById(id: string) {
    const row = await this.prisma.castingSlip.findUnique({
      where: { id },
      include: {
        intake: { select: { code: true, productName: true, qty: true } },
        images: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Không tìm thấy phiếu đúc');
    return toDetailRow(row);
  }

  /** Lên phiếu đúc từ đơn tạo (E → Chờ đúc). */
  async createFromIntake(
    intakeOrderId: string,
    dto: CreateIntakeCastingSlipDto,
    actor: AuthUserPayload,
  ) {
    const order = await this.prisma.intakeOrder.findUnique({
      where: { id: intakeOrderId },
      include: { _count: { select: { castingSlips: true } } },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    if (order.status !== IntakeOrderStatus.WAX_CONFIRMED) {
      throw new BadRequestException(
        'Chỉ lên phiếu đúc khi đơn ở trạng thái Chờ SX · Đã có Sáp',
      );
    }
    if (order._count.castingSlips > 0) {
      throw new BadRequestException('Đơn đã có phiếu đúc');
    }

    const waxRaw = order.castingTreeWeightGram ?? order.productWeightGram;
    if (waxRaw == null || waxRaw.lte(0)) {
      throw new BadRequestException('Thiếu trọng lượng sáp/cây thông trên đơn');
    }

    const slipDate = parseDate(dto.slipDate, 'Ngày phiếu');
    const flaskRows = dto.flasks.map((flask) => ({
      issueS999: flask.issueS999Gram ?? null,
      issueMaster: flask.issueMasterAlloyGram ?? null,
      issueS925: flask.issueS925Gram ?? null,
      images: this.normalizeImages(flask.images),
    }));

    for (let attempt = 0; attempt < CODE_RETRIES; attempt++) {
      const codes = flaskRows.map(() => randomSlipCode());
      try {
        const slips = await this.prisma.runTx(async (tx) => {
          const created: SlipDetailRow[] = [];
          for (let i = 0; i < flaskRows.length; i++) {
            const flask = flaskRows[i];
            const row = await tx.castingSlip.create({
              data: {
                code: codes[i],
                slipDate,
                intakeOrderId,
                waxWeightGram: waxRaw,
                batchOrderCodes: dto.batchOrderCodes,
                issueS999Gram: flask.issueS999,
                issueMasterAlloyGram: flask.issueMaster,
                issueS925Gram: flask.issueS925,
                images: { create: flask.images },
              },
              include: {
                intake: { select: { code: true, productName: true, qty: true } },
                images: { orderBy: { sortOrder: 'asc' } },
              },
            });
            created.push(row);
          }
          await tx.intakeOrder.update({
            where: { id: intakeOrderId },
            data: { status: IntakeOrderStatus.WAIT_CASTING },
          });
          return created;
        });
        return { items: slips.map(toDetailRow), count: slips.length };
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CODE_RETRIES - 1) continue;
        throw error;
      }
    }
    throw new BadRequestException('Không tạo được mã phiếu, thử lại');
  }

  private async buildListWhere(query: ListCastingSlipsQuery) {
    const and: Prisma.CastingSlipWhereInput[] = [];

    const search = query.search?.trim();
    if (search) {
      and.push({
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { batchOrderCodes: { contains: search, mode: 'insensitive' } },
          { intake: { code: { contains: search, mode: 'insensitive' } } },
        ],
      });
    }

    const slipDate = query.slipDate?.trim();
    if (slipDate) {
      const day = parseOptionalDateOnly(slipDate);
      if (day) and.push({ slipDate: day });
    }

    const intakeCode = query.intakeCode?.trim();
    if (intakeCode) {
      and.push({ intake: { code: { contains: intakeCode, mode: 'insensitive' } } });
    }

    const batchOrderCodes = query.batchOrderCodes?.trim();
    if (batchOrderCodes) {
      and.push({ batchOrderCodes: { contains: batchOrderCodes, mode: 'insensitive' } });
    }

    const waxWeight = query.waxWeight?.trim();
    if (waxWeight) {
      const ids = await this.idsMatchingWaxWeightDigits(waxWeight);
      and.push({ id: { in: ids.length ? ids : [NO_MATCH_ID] } });
    }

    const issueTotal = query.issueTotal?.trim();
    if (issueTotal) {
      const ids = await this.idsMatchingIssueTotalDigits(issueTotal);
      and.push({ id: { in: ids.length ? ids : [NO_MATCH_ID] } });
    }

    return and.length ? { AND: and } : {};
  }

  private async idsMatchingWaxWeightDigits(term: string) {
    const digits = digitsOnly(term);
    if (!digits) return [];
    const pattern = `%${digits}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM casting_slips
      WHERE regexp_replace(wax_weight_gram::text, '[^0-9]', '', 'g') LIKE ${pattern}
    `;
    return rows.map((row) => row.id);
  }

  private async idsMatchingIssueTotalDigits(term: string) {
    const digits = digitsOnly(term);
    if (!digits) return [];
    const pattern = `%${digits}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM casting_slips
      WHERE regexp_replace(
        (
          COALESCE(issue_s999_gram, 0)
          + COALESCE(issue_master_alloy_gram, 0)
          + COALESCE(issue_s925_gram, 0)
        )::text,
        '[^0-9]',
        '',
        'g'
      ) LIKE ${pattern}
    `;
    return rows.map((row) => row.id);
  }

  private normalizeImages(images: CastingSlipImageDto[]) {
    const seen = new Set<string>();
    return images
      .filter((image) => {
        if (seen.has(image.publicId)) return false;
        seen.add(image.publicId);
        return true;
      })
      .map((image, sortOrder) => {
        const host = new URL(image.url).hostname;
        if (
          host !== 'res.cloudinary.com' ||
          !this.cloudinary.ownsPublicId(image.publicId)
        ) {
          throw new BadRequestException('Ảnh không thuộc kho ảnh của hệ thống');
        }
        return {
          url: image.url,
          publicId: image.publicId,
          width: image.width ?? null,
          height: image.height ?? null,
          sortOrder,
        };
      });
  }
}

type SlipListRow = Prisma.CastingSlipGetPayload<{
  include: {
    intake: { select: { code: true; productName: true } };
    images: true;
  };
}>;

type SlipDetailRow = Prisma.CastingSlipGetPayload<{
  include: {
    intake: { select: { code: true; productName: true; qty: true } };
    images: true;
  };
}>;

function dec(value: Prisma.Decimal | null | undefined) {
  return value != null ? value.toString() : null;
}

function issueTotal(row: {
  issueS999Gram: Prisma.Decimal | null;
  issueMasterAlloyGram: Prisma.Decimal | null;
  issueS925Gram: Prisma.Decimal | null;
}) {
  let sum = 0;
  for (const part of [row.issueS999Gram, row.issueMasterAlloyGram, row.issueS925Gram]) {
    if (part != null) sum += Number(part.toString());
  }
  return String(sum);
}

function toListRow(row: SlipListRow) {
  return {
    id: row.id,
    code: row.code,
    slipDate: row.slipDate.toISOString().slice(0, 10),
    intakeOrderId: row.intakeOrderId,
    intakeCode: row.intake.code,
    intakeProductName: row.intake.productName,
    waxWeightGram: row.waxWeightGram.toString(),
    batchOrderCodes: row.batchOrderCodes,
    issueS999Gram: dec(row.issueS999Gram),
    issueMasterAlloyGram: dec(row.issueMasterAlloyGram),
    issueS925Gram: dec(row.issueS925Gram),
    issueTotalGram: issueTotal(row),
    createdAt: row.createdAt.toISOString(),
    images: row.images.map((image) => ({
      url: image.url,
      publicId: image.publicId,
      width: image.width,
      height: image.height,
    })),
  };
}

function toDetailRow(row: SlipDetailRow) {
  return {
    ...toListRow(row),
    intakeQty: row.intake.qty,
  };
}
