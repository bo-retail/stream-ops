/*
  The menu as rows: which item is current, and where a heading goes.

  The admin menu is long, so it is read in runs by job. The items, their names
  and their order are exactly the menu each person already knows; the headings
  only label runs that were already next to each other. Short menus (a packer
  has three items) get no headings, which would only be noise there.
*/

const GROUP_OF: Record<string, string> = {
  "/admin/releases": "Shows",
  "/admin/requests": "Shows",
  "/admin/schedule": "Shows",
  "/insights": "Sales",
  "/seller-insights": "Sales",
  "/profitability": "Sales",
  "/sales-reports": "Sales",
  "/shipping/log": "Shipping",
  "/shipping": "Shipping",
  "/inventory": "Shipping",
  "/admin/master": "Shipping",
  "/admin/timesheets": "Office",
  "/admin/team": "Office",
  "/admin/activity": "Office",
  "/admin/settings": "Office",
};
const GROUP_FROM = 9;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface NavRow<T> {
  item: T;
  active: boolean;
  /** A heading to print above this item, when it starts a run. */
  heading: string | null;
}

export function navRows<T extends { href: string }>(items: T[], pathname: string): NavRow<T>[] {
  // One item is current: the longest href that matches, so Packing (/shipping)
  // does not light up beside the Shipping log (/shipping/log).
  const current = items
    .filter((item) => isActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const grouped = items.length >= GROUP_FROM;
  return items.map((item, i) => {
    const group = grouped ? GROUP_OF[item.href] : undefined;
    const previous = i > 0 ? GROUP_OF[items[i - 1].href] : undefined;
    return {
      item,
      active: item.href === current,
      heading: group !== undefined && group !== previous ? group : null,
    };
  });
}
