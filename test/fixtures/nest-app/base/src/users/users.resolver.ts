import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

@Resolver()
export class UsersResolver {
  @Query(() => [String], { name: 'users' })
  findAll() {
    return [];
  }

  @Query('user')
  findOne(@Args('id') id: number) {
    return String(id);
  }

  @Mutation(() => String)
  rename(@Args('id') id: number) {
    return String(id);
  }
}
