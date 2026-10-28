import { UsersService } from './users.service';

describe('UsersService', () => {
  it('finds a user', async () => {
    const repo: any = { findOneBy: async () => ({ id: 1 }) };
    const service = new UsersService(repo);
    expect(await service.findOne(1)).toEqual({ id: 1 });
  });
});
