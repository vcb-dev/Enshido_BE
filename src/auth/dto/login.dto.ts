import { IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{3,32}$/, {
    message: 'Tài khoản không hợp lệ',
  })
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
