<template>
  <OrderRow :order="order" />
</template>

<script lang="ts">
import OrderRow from '@/components/OrderRow.vue';

export default {
  components: { OrderRow },
  data() {
    return { order: { id: '1', total: 10 } };
  },
};
</script>
