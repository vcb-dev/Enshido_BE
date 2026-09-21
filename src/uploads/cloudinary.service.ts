import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
};

/**
 * Ký request cho Cloudinary bằng API secret. Trình duyệt upload thẳng lên
 * Cloudinary với chữ ký này nên file ảnh không phải đi qua backend.
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  signUpload() {
    const { cloudName, apiKey, apiSecret, folder } = this.requireConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign({ folder, timestamp }, apiSecret);
    return { cloudName, apiKey, timestamp, folder, signature };
  }

  /** Chỉ nhận ảnh nằm trong thư mục của hệ thống, tránh gắn ảnh lạ vào đơn. */
  ownsPublicId(publicId: string) {
    const folder =
      this.config.get<string>('CLOUDINARY_FOLDER')?.trim() || 'enshido/orders';
    return publicId.startsWith(`${folder}/`);
  }

  /**
   * Xóa ảnh trên Cloudinary; lỗi chỉ ghi log vì dữ liệu đã được lưu. Gọi SAU khi đã xoá
   * dòng ảnh trong DB. Ảnh BTP chép sang đơn dùng chung publicId nên ảnh còn dòng kho
   * hoặc đơn khác trỏ tới thì giữ lại.
   */
  async destroy(candidates: string[]) {
    const publicIds = await this.unreferenced(candidates);
    if (publicIds.length === 0) return;
    const config = this.readConfig();
    if (!config) {
      this.logger.warn('Chưa cấu hình Cloudinary, bỏ qua xóa ảnh');
      return;
    }
    await Promise.all(
      publicIds.map(async (publicId) => {
        const timestamp = Math.floor(Date.now() / 1000);
        const body = new URLSearchParams({
          public_id: publicId,
          timestamp: String(timestamp),
          api_key: config.apiKey,
          signature: sign({ public_id: publicId, timestamp }, config.apiSecret),
        });
        try {
          const res = await fetch(
            `https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`,
            { method: 'POST', body },
          );
          if (!res.ok) {
            this.logger.warn(
              `Xóa ảnh ${publicId} thất bại: HTTP ${res.status}`,
            );
          }
        } catch (error) {
          this.logger.warn(`Xóa ảnh ${publicId} thất bại: ${String(error)}`);
        }
      }),
    );
  }

  private async unreferenced(publicIds: string[]) {
    const ids = Array.from(new Set(publicIds));
    if (ids.length === 0) return [];
    const where = { publicId: { in: ids } };
    const select = { publicId: true } as const;
    const [materials, orders] = await Promise.all([
      this.prisma.materialImage.findMany({ where, select }),
      this.prisma.productionOrderImage.findMany({ where, select }),
    ]);
    const used = new Set([...materials, ...orders].map((row) => row.publicId));
    return ids.filter((id) => !used.has(id));
  }

  private readConfig(): CloudinaryConfig | null {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME')?.trim();
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY')?.trim();
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET')?.trim();
    if (!cloudName || !apiKey || !apiSecret) return null;
    const folder =
      this.config.get<string>('CLOUDINARY_FOLDER')?.trim() || 'enshido/orders';
    return { cloudName, apiKey, apiSecret, folder };
  }

  private requireConfig() {
    const config = this.readConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình Cloudinary để lưu ảnh',
      );
    }
    return config;
  }
}

/** Chữ ký Cloudinary: SHA-1 của các tham số sắp theo tên, nối với API secret. */
function sign(params: Record<string, string | number>, apiSecret: string) {
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1')
    .update(payload + apiSecret)
    .digest('hex');
}
