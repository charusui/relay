import { BellRing, FlaskConical, Inbox, LayoutDashboard, MessagesSquare, Server, type LucideIcon } from 'lucide-react';

export type NavItem = { title: string; href: string; icon: LucideIcon; description: string };

export const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: 'Monitor',
    items: [
      { title: 'Overview', href: '/', icon: LayoutDashboard, description: 'Health of the agent at a glance' },
      { title: 'Conversations', href: '/conversations', icon: MessagesSquare, description: 'Every thread, with tool calls and timings' },
      { title: 'Hand-offs', href: '/handoffs', icon: Inbox, description: 'Conversations waiting for a person' },
    ],
  },
  {
    label: 'Quality',
    items: [
      { title: 'Evals', href: '/evals', icon: FlaskConical, description: 'Frozen test set, A/B experiments, failure write-ups' },
      { title: 'Alerts', href: '/alerts', icon: BellRing, description: 'Alert history, rules and the daily synthetic check' },
    ],
  },
  {
    label: 'Settings',
    items: [{ title: 'System', href: '/system', icon: Server, description: 'Model, prompt, database and region' }],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

export function navFor(pathname: string): NavItem | undefined {
  if (pathname === '/') return ALL_NAV[0];
  return ALL_NAV.filter((i) => i.href !== '/').find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
}
