// kor.js — bewaking van de KOR-omzetgrens (kleineondernemersregeling).
//
// De grens is € 20.000 omzet per kalenderjaar. Welke omzet precies meetelt
// (bijvoorbeeld bij verkoop buiten Nederland of van bedrijfsmiddelen) beslis
// je met de Belastingdienst of je boekhouder; deze indicatie gebruikt de omzet
// zoals de aangifte die uitrekent.

import { aangifteModel } from './belasting.js?v=20261023w';
import { vandaagIso } from './jaren.js?v=20261023w';

export const KOR_GRENS = 20000;

const dagenInJaar = j => (j % 4 === 0 && (j % 100 !== 0 || j % 400 === 0)) ? 366 : 365;

/** Omzet tot nu toe, ruimte tot de grens en een verwachting voor het hele jaar. */
export function korStatus(jaar) {
  const omzet = aangifteModel(jaar).resultaat.omzet;
  const nu = new Date(vandaagIso() + 'T12:00:00');
  const lopend = String(nu.getFullYear()) === String(jaar);
  const j = Number(jaar);
  let prognose = null;
  if (lopend) {
    const dag = Math.floor((nu - new Date(j, 0, 0)) / 86400000);
    if (dag >= 30) prognose = omzet / dag * dagenInJaar(j);
  }
  return {
    jaar, omzet, grens: KOR_GRENS, ruimte: KOR_GRENS - omzet, pct: omzet / KOR_GRENS, prognose,
    niveau: omzet > KOR_GRENS ? 'over' : (prognose !== null && prognose > KOR_GRENS) || omzet / KOR_GRENS >= 0.8 ? 'let-op' : 'ok'
  };
}
