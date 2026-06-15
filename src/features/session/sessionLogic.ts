import type { TradingSession } from './sessionTypes';

function isDst(utcDate: Date) {
  const year = utcDate.getUTCFullYear();
  const march1 = new Date(Date.UTC(year, 2, 1));
  const firstSundayMarchOffset = (7 - march1.getUTCDay()) % 7;
  const dstStart = new Date(Date.UTC(year, 2, 1 + firstSundayMarchOffset + 7, 7));
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSundayNovOffset = (7 - nov1.getUTCDay()) % 7;
  const dstEnd = new Date(Date.UTC(year, 10, 1 + firstSundayNovOffset, 6));
  return utcDate >= dstStart && utcDate < dstEnd;
}

export function toEasternTime(utcDate = new Date()) {
  const offsetHours = isDst(utcDate) ? -4 : -5;
  return new Date(utcDate.getTime() + offsetHours * 60 * 60 * 1000);
}

function etLabel(etDate: Date) {
  const hh = String(etDate.getUTCHours()).padStart(2, '0');
  const mm = String(etDate.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} ET`;
}

export function getTradingSession(utcDate = new Date()): TradingSession {
  const et = toEasternTime(utcDate);
  const weekday = et.getUTCDay();
  const hour = et.getUTCHours() + et.getUTCMinutes() / 60;
  const currentMinutes = et.getUTCHours() * 60 + et.getUTCMinutes();
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;

  const minsToOpen = () => Math.max(0, openMinutes - currentMinutes);
  const minsToClose = () => Math.max(0, closeMinutes - currentMinutes);

  if (weekday === 0 || weekday === 6) {
    return {
      name: 'weekend',
      label: 'WEEKEND',
      enginesAllowed: [],
      sizeMult: 0,
      orderType: null,
      tradeable: false,
      volWindow: 'rolling20',
      etTime: etLabel(et),
    };
  }

  if (hour >= 4 && hour < 9) {
    return {
      name: 'pre',
      label: 'PRE-MARKET',
      enginesAllowed: ['E5'],
      sizeMult: 0.5,
      orderType: 'limit',
      tradeable: true,
      volWindow: 'rolling20',
      minsToOpen: minsToOpen(),
      etTime: etLabel(et),
    };
  }

  if (hour >= 9 && hour < 9.5) {
    return {
      name: 'warming',
      label: 'WARMING UP',
      enginesAllowed: ['E1', 'E2', 'E3', 'E4', 'E5'],
      sizeMult: 0,
      orderType: null,
      tradeable: false,
      scan: true,
      volWindow: 'rolling20',
      minsToOpen: minsToOpen(),
      etTime: etLabel(et),
    };
  }

  if (hour >= 9.5 && hour < 16) {
    return {
      name: 'regular',
      label: 'REGULAR',
      enginesAllowed: ['E1', 'E2', 'E3', 'E4', 'E5'],
      sizeMult: 1,
      orderType: 'market',
      tradeable: true,
      volWindow: 'session',
      minsToClose: minsToClose(),
      etTime: etLabel(et),
    };
  }

  if (hour >= 16 && hour < 20) {
    return {
      name: 'post',
      label: 'AFTER-HOURS',
      enginesAllowed: ['E5'],
      sizeMult: 0.5,
      orderType: 'limit',
      tradeable: true,
      volWindow: 'rolling20',
      etTime: etLabel(et),
    };
  }

  let nextOpenMinutes: number;
  if (weekday >= 1 && weekday <= 5 && currentMinutes < openMinutes) {
    nextOpenMinutes = openMinutes - currentMinutes;
  } else {
    const daysAhead = weekday === 5 ? 3 : 1;
    nextOpenMinutes = daysAhead * 24 * 60 + openMinutes - currentMinutes;
  }

  return {
    name: 'closed',
    label: 'CLOSED',
    enginesAllowed: [],
    sizeMult: 0,
    orderType: null,
    tradeable: false,
    volWindow: 'rolling20',
    minsToOpen: nextOpenMinutes,
    etTime: etLabel(et),
  };
}
