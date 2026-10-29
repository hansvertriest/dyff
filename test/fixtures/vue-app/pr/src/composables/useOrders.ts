export interface Order {
  id: string;
  total: number;
}

export function useOrders(): Order[] {
  return [{ id: '1', total: 10 }];
}

export function formatTotal(total: number, currency = 'EUR'): string {
  return `${total.toFixed(2)} ${currency}`;
}
