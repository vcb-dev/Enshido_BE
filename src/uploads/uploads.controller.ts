import { Controller, Post } from '@nestjs/common';
import { AllowCustomer } from '../auth/decorators';
import { CloudinaryService } from './cloudinary.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly cloudinary: CloudinaryService) {}

  @Post('cloudinary-signature')
  // Khách VCB gửi ảnh mẫu khi tạo / sửa đơn.
  @AllowCustomer()
  signature() {
    return this.cloudinary.signUpload();
  }
}
