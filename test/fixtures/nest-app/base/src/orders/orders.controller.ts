import { Body, Controller, Param, Post } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Controller({ path: 'orders' })
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post(':userId')
  create(@Param('userId') userId: string, @Body() dto: CreateOrderDto) {
    return this.ordersService.createForUser(+userId, dto);
  }
}
