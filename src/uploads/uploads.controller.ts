import { Controller, Post } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly cloudinary: CloudinaryService) {}

  @Post('cloudinary-signature')
  signature() {
    return this.cloudinary.signUpload();
  }
}
