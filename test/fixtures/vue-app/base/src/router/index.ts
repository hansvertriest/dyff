import OrdersView from '@/views/OrdersView.vue';

export const routes = [
  {
    path: '/orders',
    children: [
      { path: '', component: OrdersView },
      { path: ':id', component: () => import('@/views/OrderDetail.vue') },
    ],
  },
];
