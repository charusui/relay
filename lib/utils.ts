// Class-name helper used by the shadcn/ui components: clsx for conditional
// classes, tailwind-merge so later Tailwind classes win over earlier ones.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
