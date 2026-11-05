// Pages load with ?hl=en, so English should match. The other languages cover accounts where
// Instagram keeps the account's own language anyway.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (words: string[]) => new RegExp(`^\\s*(${words.map(escape).join("|")})\\s*$`, "i");

export const labels = {
  newPostIcon: ["New post", "Nuovo post", "Nueva publicación", "Nouvelle publication", "Neuer Beitrag", "Nova publicação"],
  create: exact(["Create", "Crea", "Crear", "Créer", "Erstellen", "Criar"]),
  postMenuItem: exact(["Post"]),
  next: exact(["Next", "Avanti", "Siguiente", "Suivant", "Weiter", "Avançar"]),
  share: exact(["Share", "Condividi", "Compartir", "Partager", "Teilen", "Compartilhar"]),
  schedule: exact(["Schedule", "Programma", "Programar", "Programmer", "Planen", "Agendar"]),
  scheduleSwitch: exact(["Schedule content", "Programma contenuti", "Programma contenuto"]),
  scheduled: /(has been scheduled|post scheduled|reel scheduled|è stato programmato|programmato)/i,
  ok: exact(["OK"]),
  shared: /(has been shared|post shared|reel shared|è stato condiviso|se ha compartido|a été partagé|wurde geteilt|foi compartilhad)/i,
  shareFailed: /(couldn't be shared|could not be shared|wasn't shared|something went wrong|non è stato possibile condividere|si è verificato un problema)/i,
};
