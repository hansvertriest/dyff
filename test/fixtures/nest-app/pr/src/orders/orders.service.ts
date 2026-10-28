import { Inject, Injectable } from '@nestjs/common';
import { UsersService } from '../users';
import { CreateOrderDto } from './dto/create-order.dto';

export const ORDERS_REPO = 'ORDERS_REPO';

@Injectable()
export class OrdersService {
  constructor(
    private readonly usersService: UsersService,
    @Inject(ORDERS_REPO) private readonly repo: any,
  ) {}

  async createForUser(userId: number, dto: CreateOrderDto) {
    const user = await this.usersService.findOne(userId);
    const total = dto.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const order = this.repo.create({ ...dto, user, total });
    return this.repo.save(order);
  }
}
