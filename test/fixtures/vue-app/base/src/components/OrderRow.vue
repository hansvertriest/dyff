<script setup lang="ts">
import { formatTotal, type Order } from '@/composables/useOrders';

defineProps<{ order: Order }>();
</script>

<template>
  <li class="row">
    <span>{{ order.id }}</span>
    <span>{{ formatTotal(order.total) }}</span>
  </li>
</template>

<style scoped>
.row { display: flex; }
</style>
