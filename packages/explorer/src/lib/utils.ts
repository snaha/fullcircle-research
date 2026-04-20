import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & { ref?: El | null }

export type WithoutChild<T> = T extends { child?: infer _C } ? Omit<T, 'child'> : T
export type WithoutChildren<T> = T extends { children?: infer _C } ? Omit<T, 'children'> : T
export type WithoutChildrenOrChild<T> = T extends { children?: infer _C; child?: infer _C2 }
  ? Omit<T, 'children' | 'child'>
  : T
