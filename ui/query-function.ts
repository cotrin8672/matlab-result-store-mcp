import type { QueryDefinition } from '../queries.ts';

let nextId = 0;
export function queryFunction(selected: QueryDefinition, available: readonly QueryDefinition[], onChange: (name: QueryDefinition['name']) => void, ariaLabel: string): HTMLElement {
  const control = document.createElement('div'); control.className = 'query-function-control';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'query-function';
  const label = document.createElement('span'); trigger.append(label);
  const popup = document.createElement('div'); popup.className = 'query-functions'; popup.popover = 'auto';
  const list = document.createElement('div'); list.className = 'query-function-options'; list.id = `query-functions-${++nextId}`;
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', ariaLabel);
  const hint = document.createElement('p'); hint.className = 'query-function-hint'; hint.id = `${list.id}-hint`;
  hint.setAttribute('role', 'status'); hint.setAttribute('aria-atomic', 'true');
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-controls', list.id); trigger.setAttribute('aria-expanded', 'false');
  function paint() {
    label.textContent = selected.name; trigger.title = selected.hint; trigger.setAttribute('aria-label', `${ariaLabel}: ${selected.name}`);
    options.forEach((option, index) => option.setAttribute('aria-selected', String(available[index].name === selected.name)));
  }
  function close(returnFocus = false) {
    if (popup.matches(':popover-open')) popup.hidePopover();
    if (returnFocus) trigger.focus();
  }
  function focus(index: number) {
    options.forEach((option, i) => { option.tabIndex = i === index ? 0 : -1; });
    options[index]?.focus(); options[index]?.scrollIntoView({ block: 'nearest' });
  }
  function position() {
    const anchor = trigger.getBoundingClientRect();
    popup.style.width = `${Math.min(Math.max(anchor.width, 280), innerWidth - 16)}px`;
    const box = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
    const top = anchor.bottom + 4 + box.height <= innerHeight - 8 ? anchor.bottom + 4 : anchor.top - box.height - 4;
    popup.style.top = `${Math.max(8, Math.min(top, innerHeight - box.height - 8))}px`;
  }
  function open(index = available.findIndex(q => q.name === selected.name)) {
    popup.showPopover(); focus(Math.max(0, index)); position();
  }
  const options = available.map(definition => {
    const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
    option.setAttribute('role', 'option'); option.setAttribute('aria-describedby', hint.id); option.textContent = definition.name;
    const describe = () => { hint.textContent = definition.hint; if (popup.matches(':popover-open')) position(); };
    option.onmouseenter = describe; option.onfocus = describe;
    option.onclick = () => { const changed = selected.name !== definition.name; selected = definition; paint(); close(true); if (changed) onChange(definition.name); };
    return option;
  });
  trigger.disabled = !options.length;
  trigger.onclick = () => popup.matches(':popover-open') ? close() : open();
  trigger.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); open(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : undefined);
  };
  popup.onkeydown = event => {
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      focus(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') { event.preventDefault(); options[index]?.click(); }
  };
  popup.onbeforetoggle = event => trigger.setAttribute('aria-expanded', String((event as ToggleEvent).newState === 'open'));
  popup.addEventListener('focusout', event => { if (!control.contains(event.relatedTarget as Node | null)) close(); });
  list.append(...options); popup.append(list, hint); control.append(trigger, popup); paint();
  return control;
}
