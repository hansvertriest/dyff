import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  async create(dto: CreateUserDto) {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.repo.create({ ...dto, passwordHash });
    return this.repo.save(user);
  }

  async findOne(id: number, withOrders = false) {
    const user = await this.repo.findOne({ where: { id }, relations: withOrders ? ['orders'] : [] });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string) {
    return this.repo.findOneBy({ email });
  }
}
