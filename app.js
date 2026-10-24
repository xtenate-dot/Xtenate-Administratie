// app.js — startpunt. Koppelt module-functies aan `window` zodat de onclick-
// attributen in index.html blijven werken, regelt de globale interacties
// (detailpaneel, zoeken, sneltoetsen) en start de app op.

import { state } from './storage.js?v=20261024j';
import { nav, gaNaar, hertekenHuidigePagina, paginaUitHash } from './ui.js?v=20261024j';
import { initBonnetjes } from './bonnetjes.js?v=20261024j';
import { startAutosync, syncNu } from './autosync.js?v=20261024j';
import { wisselJaar, renderHome } from './dashboard.js?v=20261024j';
import { renderBank, kiesBankMaand, toonAlleBankBoekingen, openTxModal, closeTx, saveTx, syncTxGrootboek, syncTxBtw, bewerkBoeking, deleteTx } from './bank.js?v=20261024j';
import {
  renderFacturen, kiesFactuurTab,
  openFactuurModal, sluitFactuurModal, syncFactuurVervaldatum, factVervaldatumHandmatig,
  saveFactuur, verwijderFactuurUitModal,
  sluitKoppelModal, zoekFactuurBoeking,
  zoekFactuurRelatie, sluitFactuurRelatieSuggesties,
  openRelatiesBeheerModal, sluitRelatiesBeheerModal, voegNieuweRelatieToe, bewaarRelatiesBeheer
} from './facturen-ui.js?v=20261024j';
import { openIbanClusterScherm } from './boekingen-relaties-ui.js?v=20261024j';
import './uren-ui.js?v=20261024j';
import { verwerkBankTerugkeer } from './bankkoppelen.js?v=20261024j';
import { renderKm, openRitModal, sluitRitModal, saveRit, verwijderRitUi, verwijderRitUitModal } from './km-ui.js?v=20261024j';
import { kiesRevolutBestand, leesRevolutBestand, zetBankimportKeuze, importeerRevolut, verwijderBankimportRegel } from './bankimport.js?v=20261024j';
import { wisselVergrendeling, legEindvoorraadVast } from './jaarafsluiting.js?v=20261024j';
import { zetHerstelpuntTerug } from './herstelpunt.js?v=20261024j';
import { kiesPeriodeSoort, kiesPeriodeJaar, kiesPeriodeWeergave, downloadPeriodeExcel } from './periode.js?v=20261024j';
import { kiesVeilingBestand, importeerVeiling } from './veiling-ui.js?v=20261024j';
import { renderActiva, openActivumModal, sluitActivumModal, saveActivum, verwijderActivumUi, verwijderActivumUitModal } from './activa-ui.js?v=20261024j';
import { renderBeheer, bewaarMinVoorraad, bewaarReferentiePriveSt2022, herprobeerSynchronisatie, bewaarBtwVanaf, bewaarBedrijfsgegevens, bewaarKmTarief, bewaarFactuurInstellingen, bewaarBankKoppelingRek } from './beheer.js?v=20261024j';
import { renderPortaal } from './home.js?v=20261024j';
import {
  renderGrootboek, wisFiltersGrootboek, openGrootboekRekening, sluitGrootboekRekening,
  openGrootboekBeheerModal, sluitGrootboekBeheerModal, voegGrootboekToe, verwijderGrootboek,
  voegRekeningToe, verwijderRekening, bewaarGrootboekBeheer
} from './grootboek.js?v=20261024j';
import { renderBelasting, openTarieven, openExtraKosten, openPercentages, openInkomenssoort, controlereBelasting, openControleDialog, kopieerAangifte, downloadAangifte, downloadAangiftePdf } from './belasting.js?v=20261024j';
import { wisselBtwKwartaal, downloadBtwPdf } from './btw.js?v=20261024j';
import { renderCrediteuren, wisselJaarCrediteuren } from './crediteuren.js?v=20261024j';
import { renderDebiteuren, wisselJaarDebiteuren } from './debiteuren.js?v=20261024j';
import {
  renderControle, klapControleUit, toonAlleControleRegels, verbergControleMelding,
  zetControleUitVanaf, herstelControleMelding, herstelControleReeks, herstelAlleMeldingen
} from './controle.js?v=20261024j';
import {
  renderCovers, openCoverModal, openCoverEdit, closeCoverModal, saveCover, kiesVoorraadTab,
  wisselVoorraadDetails, wisselDetailKolommen, filterVoorraadStatus,
  wisselVoorraadSelectie, selecteerAlleVoorraad, verplaatsVoorraadSelectie, wisVoorraadSelectie, zetHandelsvoorraadSelectie,
  openVerdeling, sluitVerdeling, herstelVerdeling, wijzigFactor, bewaarVerdeling,
  openVoorraadSyncModal, sluitVoorraadSyncModal, startVoorraadSync,
  draaiActieTerug, openGroepenModal, sluitGroepenModal, voegGroepToe, verwijderGroep, bewaarGroepen,
  kiesVoorraadJaar, legVoorraadVast, verwijderArtikel, verwijderVoorraadSelectie,
  openImportModalVoorraad, sluitImportModal, handleImportVoorraad, exporteerVoorraadPdf
} from './voorraad.js?v=20261024j';
import {
  renderHNVI, berekenHNVIInkoop, openHNVIModal, openHNVISell, closeHNVIModal, saveHNVI,
  wisHNVIVerkoop, verwijderHNVIItem, toggleAllHNVI, updateHNVIDeleteBtn, verwijderGeselecteerdeHNVI,
  importHNVIFactuur, bevestigHNVIImport, exporteerHnviPdf
} from './hnvi.js?v=20261024j';
import {
  importExcel, openWisModal, doWis, toonWisPreview, openSyncModal, saveSyncUrl, syncUpload, syncDownload,
  openApiKeyModal, saveApiKey, bevestigImport, annuleerImport
} from './modals.js?v=20261024j';
import { initUiVoorkeuren, wisselThema, wisselMenu, wisselMobielMenu, sluitMobielMenu } from './theme.js?v=20261024j';
import { wisselNavGroep, initNavGroepen } from './navgroepen.js?v=20261024j';
import { initZoek, focusZoek, sluitZoek } from './search.js?v=20261024j';
import { openExportModal, sluitExportModal, toonExportSamenvatting, doeExport } from './excel-ui.js?v=20261024j';
import { openZelftestModal, sluitZelftestModal, startZelftest } from './zelftest-ui.js?v=20261024j';
import {
  openOpslagDiagnose, sluitOpslagDiagnose, voerOpslagDiagnoseUit, kopieerOpslagDiagnose,
  maakOpslagSnapshot, toonOverrides, toonNegeerlijst, downloadBackup, downloadNegeerBestanden
} from './opslagdiagnose-ui.js?v=20261024j';
import {
  openGegevenscontrole, sluitGegevenscontrole, herlaadGegevenscontrole,
  kiesGc, annuleerGc, bevestigGc, maakKeuzeOngedaan,
  exporteerGcMeldingen, controleerGcSchrijfacties
} from './gegevenscontrole-ui.js?v=20261024j';
import {
  openUitvoeren, sluitUitvoeren, doeStapBackup, zetBegrepen, doeStapUitvoeren
} from './uitvoeren-ui.js?v=20261024j';
import { vertraag } from './helpers.js?v=20261024j';
import { toonBoeking, sluitDrawer, openBoeking } from './drawer.js?v=20261024j';
import { start as startAuth, login, uitloggen, opnieuwVerbinden, toonRegistreren, toonInloggen, signUp } from './auth.js?v=20261024j';

// Zoeken tijdens typen wacht kort: anders wordt bij elke aanslag de hele
// tabel opnieuw opgebouwd, wat bij honderden regels merkbaar hapert.
const zoekGrootboekVertraagd = vertraag(renderGrootboek);
const zoekVoorraadVertraagd = vertraag(renderCovers);

// Bijlagen (bonnetjes) staan apart in IndexedDB; na het inlezen even herladen voor de paperclips.
window.hertekenBankNaBonnetje = () => hertekenHuidigePagina();
initBonnetjes().then(() => hertekenHuidigePagina());

Object.assign(window, {
  legEindvoorraadVast,
  zoekGrootboekVertraagd, zoekVoorraadVertraagd,
  nav, gaNaar, wisselJaar, hertekenHuidigePagina, paginaUitHash,
  renderBank, openTxModal, closeTx, saveTx, syncTxGrootboek, syncTxBtw, bewerkBoeking, deleteTx,
  renderFacturen, kiesFactuurTab, renderBeheer, renderPortaal,
  openFactuurModal, sluitFactuurModal, syncFactuurVervaldatum, factVervaldatumHandmatig,
  saveFactuur, verwijderFactuurUitModal, sluitKoppelModal, zoekFactuurBoeking,
  zoekFactuurRelatie, sluitFactuurRelatieSuggesties,
  openRelatiesBeheerModal, sluitRelatiesBeheerModal, voegNieuweRelatieToe, bewaarRelatiesBeheer,
  openIbanClusterScherm,
  renderKm, openRitModal, sluitRitModal, saveRit, verwijderRitUi, verwijderRitUitModal, bewaarKmTarief,
  renderActiva, openActivumModal, sluitActivumModal, saveActivum, verwijderActivumUi, verwijderActivumUitModal,
  kiesVeilingBestand, importeerVeiling, kiesPeriodeSoort, kiesPeriodeJaar, kiesPeriodeWeergave, downloadPeriodeExcel,
  renderCrediteuren, wisselJaarCrediteuren, renderDebiteuren, wisselJaarDebiteuren,
  renderGrootboek, wisFiltersGrootboek, openGrootboekRekening, sluitGrootboekRekening,
  openGrootboekBeheerModal, sluitGrootboekBeheerModal, voegGrootboekToe, verwijderGrootboek,
  voegRekeningToe, verwijderRekening, bewaarGrootboekBeheer,
  zetHerstelpuntTerug, wisselVergrendeling, kiesBankMaand, toonAlleBankBoekingen,
  kiesRevolutBestand, leesRevolutBestand, zetBankimportKeuze, importeerRevolut, verwijderBankimportRegel,
  renderBelasting, openTarieven, openExtraKosten, openPercentages, openInkomenssoort, controlereBelasting, openControleDialog, kopieerAangifte, downloadAangifte, downloadAangiftePdf,
  wisselBtwKwartaal, downloadBtwPdf,
  renderControle, klapControleUit, toonAlleControleRegels,
  verbergControleMelding, zetControleUitVanaf, herstelControleMelding, herstelControleReeks, herstelAlleMeldingen,
  renderCovers, openCoverModal, openCoverEdit, closeCoverModal, saveCover, kiesVoorraadTab,
  wisselVoorraadDetails, wisselDetailKolommen, filterVoorraadStatus, bewaarMinVoorraad, bewaarReferentiePriveSt2022, herprobeerSynchronisatie, bewaarBtwVanaf, bewaarBedrijfsgegevens, bewaarFactuurInstellingen, bewaarBankKoppelingRek,
  wisselVoorraadSelectie, selecteerAlleVoorraad, verplaatsVoorraadSelectie, wisVoorraadSelectie, zetHandelsvoorraadSelectie,
  openVerdeling, sluitVerdeling, herstelVerdeling, wijzigFactor, bewaarVerdeling,
  openVoorraadSyncModal, sluitVoorraadSyncModal, startVoorraadSync,
  syncNu,
  draaiActieTerug, openGroepenModal, sluitGroepenModal, voegGroepToe, verwijderGroep, bewaarGroepen,
  kiesVoorraadJaar, legVoorraadVast, verwijderArtikel, verwijderVoorraadSelectie,
  openImportModalVoorraad, sluitImportModal, handleImportVoorraad, exporteerVoorraadPdf,
  renderHNVI, berekenHNVIInkoop, openHNVIModal, openHNVISell, closeHNVIModal, saveHNVI,
  wisHNVIVerkoop, verwijderHNVIItem, toggleAllHNVI, updateHNVIDeleteBtn, verwijderGeselecteerdeHNVI,
  importHNVIFactuur, bevestigHNVIImport, exporteerHnviPdf,
  importExcel, openWisModal, doWis, toonWisPreview, openSyncModal, saveSyncUrl, syncUpload, syncDownload,
  openApiKeyModal, saveApiKey,
  openExportModal, sluitExportModal, toonExportSamenvatting, doeExport,
  openZelftestModal, sluitZelftestModal, startZelftest,
  openGegevenscontrole, sluitGegevenscontrole, herlaadGegevenscontrole,
  kiesGc, annuleerGc, bevestigGc, maakKeuzeOngedaan,
  exporteerGcMeldingen, controleerGcSchrijfacties,
  openUitvoeren, sluitUitvoeren, doeStapBackup, zetBegrepen, doeStapUitvoeren,
  bevestigImport, annuleerImport,
  openOpslagDiagnose, sluitOpslagDiagnose, voerOpslagDiagnoseUit, kopieerOpslagDiagnose, maakOpslagSnapshot, toonOverrides, toonNegeerlijst, downloadBackup, downloadNegeerBestanden,
  login, uitloggen, opnieuwVerbinden, toonRegistreren, toonInloggen, signUp,
  wisselThema, wisselMenu, wisselMobielMenu, sluitMobielMenu,
  wisselNavGroep,
  sluitDrawer
});

// ---------- Voorkeuren (thema, ingeklapt menu) ----------
initUiVoorkeuren();
initNavGroepen();
initZoek();

// ---------- Modals sluiten bij klik buiten ----------
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  if (overlay.id === 'modal-hnvi') return; // deze mag alleen via de knoppen dicht
  if (overlay.id === 'modal-tx') return; // Fase 4: boeking-modal sluit NIET via click-outside
  if (overlay.id === 'modal-factuur') return; // zelfde bescherming: geen formulierverlies door een verdwaalde klik
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
});

// Fase 4: ESC sluit modal-tx (maar niet via click-outside)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('modal-tx');
    if (modal && modal.classList.contains('open')) {
      modal.classList.remove('open');
    }
  }
});

// ---------- Doorklikken naar een boeking ----------
// Eén luisteraar voor de hele app: rijen worden telkens opnieuw getekend,
// dus losse handlers per rij zouden steeds opnieuw gezet moeten worden.
document.addEventListener('click', e => {
  // Bewerkknop in het detailpaneel: paneel dicht, dan de modal open.
  const bewerkKnop = e.target.closest('[data-bewerk-tx]');
  if (bewerkKnop) {
    sluitDrawer();
    bewerkBoeking(bewerkKnop.dataset.bewerkTx);
    return;
  }

  // Dan de controlepagina: die regels zijn zelf knoppen, dus de uitzondering
  // hieronder zou ze anders wegfilteren.
  const controle = e.target.closest('.ctrl-item-main[data-ga]');
  if (controle) {
    const scheiding = controle.dataset.ga.indexOf(':');
    const soort = controle.dataset.ga.slice(0, scheiding);
    const waarde = controle.dataset.ga.slice(scheiding + 1);
    if (soort === 'tx') bewerkBoeking(waarde);                       // meteen te herstellen
    else if (soort === 'boeking') openBoeking(waarde);                // alleen bekijken
    else if (soort === 'gb') { gaNaar('grootboek'); openGrootboekRekening(waarde); }
    else if (soort === 'artikel') { gaNaar('voorraad'); openCoverEdit(waarde); }
    else if (soort === 'lot') { gaNaar('hnvi'); openHNVISell(waarde); }
    else if (soort === 'pagina') gaNaar(waarde);
    return;
  }

  if (e.target.closest('button, a, input, select')) return;

  const boeking = e.target.closest('.row-click[data-id]');
  if (boeking) { toonBoeking(boeking.dataset.id, boeking); return; }

  const rekening = e.target.closest('.gb-rij[data-gb]');
  if (rekening) openGrootboekRekening(rekening.dataset.gb);
});

// Grootboekrijen en voorraadtabs zijn ook met het toetsenbord te bedienen.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const rekening = e.target.closest?.('.gb-rij[data-gb]');
  if (rekening) { e.preventDefault(); openGrootboekRekening(rekening.dataset.gb); return; }
  const tab = e.target.closest?.('.vtab[onclick]');
  if (tab) { e.preventDefault(); tab.click(); }
});

// ---------- Sneltoetsen ----------
document.addEventListener('keydown', e => {
  const inVeld = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);

  // Zoeken openen
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusZoek(); return; }
  if (e.key === '/' && !inVeld) { e.preventDefault(); focusZoek(); return; }

  // Alles sluiten
  if (e.key === 'Escape') {
    sluitZoek();
    sluitDrawer();
    sluitMobielMenu();
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    return;
  }

  // Cijfers 1-6 springen naar een pagina
  if (!inVeld && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const paginas = ['home', 'overzicht', 'bank', 'facturen', 'grootboek',
      'belasting', 'voorraad', 'hnvi', 'beheer'];
    const index = parseInt(e.key, 10) - 1;
    if (index >= 0 && index < paginas.length) { e.preventDefault(); gaNaar(paginas[index]); }
  }
});

// ---------- Jaarselector ----------
// De opties stonden vast in de HTML, met 2025 als geselecteerde. Daardoor
// kwam je na elke refresh in een afgesloten jaar terecht, en zou 2027 er
// handmatig bij moeten. Nu wordt de lijst opgebouwd vanaf het kalenderjaar
// terug tot 2022, en staat het huidige jaar voorgeselecteerd.
function vulJaarSelector() {
  const sel = document.getElementById('jaar-selector');
  if (!sel) return;
  const nu = new Date().getFullYear();
  const jaren = [];
  for (let j = nu; j >= 2022; j--) jaren.push(String(j));
  sel.innerHTML = '<option value="all">Alle jaren</option>' +
    jaren.map(j => `<option value="${j}">${j}</option>`).join('');
  sel.value = state.huidigJaar && [...sel.options].some(o => o.value === state.huidigJaar)
    ? state.huidigJaar
    : String(nu);
  state.huidigJaar = sel.value;
}

// ---------- Start ----------
// De administratie wordt pas getekend als er een geldige sessie is. Alles
// hierboven is voorbereiding; de gegevens komen nog uit dezelfde bron als
// voorheen, er is alleen een deur voor gezet.
// Na inloggen naar de pagina uit de hash, zodat een refresh je op je plek laat.
// Zonder hash is dat 'home', precies zoals voorheen.
startAuth(() => {
  vulJaarSelector();
  gaNaar(paginaUitHash());
  startAutosync();
  verwerkBankTerugkeer();
});
