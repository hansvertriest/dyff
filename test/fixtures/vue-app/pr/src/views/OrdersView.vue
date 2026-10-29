<script setup lang="ts">
import OrderRow from '../components/OrderRow.vue';
import { useOrders } from '@/composables/useOrders';

const orders = useOrders();

function refresh() {
  return orders.length;
}
</script>

<template>
  <section>
    <h1>Your orders</h1>
    <ul>
      <order-row v-for="o in orders" :key="o.id" :order="o" />
    </ul>
    <button @click="refresh">Refresh</button>
  </section>
</template>
