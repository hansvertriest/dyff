import { Injectable } from '@nestjs/common';
import { UsersService } from '@app/users/users.service';

@Injectable()
export class ReportsService {
  constructor(private readonly usersService: UsersService) {}

  exportUsers() {
    return this.usersService.findAllLegacy();
  }

  userSummary(id: number) {
    return this.usersService.findOne(id);
  }
}
