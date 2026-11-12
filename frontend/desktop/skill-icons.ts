// Bundled Classic World icons from Mapledex; keyed by actual game IDs.
// The client serves them next to its page; the website from /web/img/grind-icons.
let base = './grind-icons';
export const setGrindIconBase = (path: string) => { base = path; };
export const grindIcon = (file: string) => `${base}/${file}`;
export const skillIcon = (id: number) => grindIcon(`skills/${id}.png`);
export const mobIcon = (id: number) => grindIcon(`monsters/${id}.png`);
