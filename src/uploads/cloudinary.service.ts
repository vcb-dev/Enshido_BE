import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

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

  constructor(private readonly config: ConfigService) {}

  signUpload() {
    const { cloudName, apiKey, apiSecret, folder } = this.requireConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign({ folder, timestamp }, apiSecret);
    return { cloudName, apiKey, timestamp, folder, signature };
  }

  /** Chỉ nhận ảnh nằm trong thư mục của hệ thống, tránh gắn ảnh lạ vào đơn. */
  ownsPublicId(publicId: string) {
    const folder = this.config.get<string>(
      'CLOUDINARY_FOLDER',
      'enshido/orders',
    );
    return publicId.startsWith(`${folder}/`);
  }

  /** Xóa ảnh trên Cloudinary; lỗi chỉ ghi log vì dữ liệu đơn đã được lưu. */
  async destroy(publicIds: string[]) {
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

  private readConfig(): CloudinaryConfig | null {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (!cloudName || !apiKey || !apiSecret) return null;
    const folder = this.config.get<string>(
      'CLOUDINARY_FOLDER',
      'enshido/orders',
    );
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
