import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions(Permission.USERS_MANAGE)
  list() {
    return this.usersService.list();
  }

  @Post()
  @RequirePermissions(Permission.USERS_MANAGE)
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.USERS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }
}
