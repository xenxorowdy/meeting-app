import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility to merge conditional class names with Tailwind conflict resolution
 * @param  {...any} inputs
 * @returns {string}
 */
export function cn(...inputs) {
    try {
        return twMerge(clsx(inputs));
    } catch (e) {
        return clsx(inputs);
    }
}
