# Quick Ask: plan i zadania

Aplikacja działa w tle. Przytrzymujesz klawisz, mówisz pytanie, puszczasz, a nad ekranem pojawia się
odpowiedź z modelu AI. Ustawienia są w menu ikony w zasobniku systemowym (tray / pasek menu).

## Decyzje

| Obszar | Decyzja |
|---|---|
| Stack | Electron + TypeScript + electron-vite; renderer w React 19 + Tailwind v4 |
| Renderowanie odpowiedzi | [Streamdown](https://streamdown.ai): markdown streamowany token po tokenie, podświetlanie kodu (Shiki) |
| Klucze AI | BYOK przez **OpenRouter**: jeden klucz, dowolny model. Bez kont i logowania: użytkownik sam wkleja swój klucz |
| Przepływ | nagranie (WAV 16 kHz mono) → `POST /api/v1/audio/transcriptions` → tekst → `POST /api/v1/chat/completions` (stream) |
| Format nagrania | WAV zamiast WebM: przyjmuje go każdy model transkrypcji (np. Grok STT nie obsługuje WebM) |
| Okna | nagrywanie: mała pigułka zawsze na wierzchu, bez fokusu (tam też działa nagrywarka); rozmowa: zwykłe okno aplikacji (pasek zadań, można je przykryć, zmienić rozmiar), zamknięcie tylko je chowa, rozmiar i położenie są zapamiętywane |
| Tło okna | pełny grafit; okno rozmowy bez systemowego paska tytułu, przyciski okna rysuje system nad naszym nagłówkiem |
| Skrót | **push-to-talk**: trzymasz = nagrywa, puszczasz = wysyła. `uiohook-napi` (globalne keydown/keyup) |
| Klawisz domyślny | Windows/Linux: prawy Ctrl (nie prawy Alt, bo to AltGr dla polskich znaków), macOS: prawy Option |
| Wątki | okno rozmowy otwarte (także zminimalizowane lub przykryte) + klawisz = dopytanie w tym samym wątku; zamknięte = nowa rozmowa |
| Klucz API | tylko w procesie głównym, szyfrowany przez `safeStorage` (Keychain / DPAPI / libsecret) |
| Bezpieczeństwo UI | renderer z `sandbox` + `contextIsolation`; w odpowiedziach bez surowego HTML i bez obrazków, linki tylko http(s)/mailto i zawsze w przeglądarce |
| Wygląd | grafitowe tło (#1E1E22) + czerwony akcent (#E9383F); ikona: „Q” jako dymek z paskami głosu |
| Narzędzia AI | kilka małych, pewnych narzędzi zamiast katalogu: sandbox JS (obliczenia i dane), wykresy, kursy NBP, pogoda, strefy czasowe; każde można wyłączyć. Niczego, co czyta prywatne dane (schowek, ekran), model nie wywołuje sam |

## Zadania

Legenda: `[x]` zrobione, `[ ]` do zrobienia.

### M0: Fundamenty
- [x] T0.1 Repo, scaffold Electron + TypeScript + electron-vite, skrypty `dev` / `build` / `typecheck`
- [x] T0.2 Cykl życia apki: jedna instancja, brak ikony w Docku, działanie w tle bez okien
- [x] T0.3 Ustawienia w JSON (`userData/settings.json`) + klucz API przez `safeStorage`
- [x] T0.4 Ikony z jednego wektora (`npm run icons`): ikona aplikacji, zasobnik, stan nagrywania, template dla macOS
- [x] T0.5 Tryb diagnostyczny `QUICK_ASK_DEBUG=1` (logi + zrzut samego okna overlay)

### M1: Push-to-talk i nagrywanie
- [x] T1.1 Maszyna stanów push-to-talk na `uiohook-napi`: start przy wciśnięciu, anulowanie gdy w trakcie wciśnięto inny klawisz / kliknięto myszą, ignorowanie krótkich tapnięć i autorepeat
- [x] T1.2 Okno overlay: bez ramki, przezroczyste, zawsze na wierzchu, na górze ekranu z kursorem, bez kradzieży fokusu
- [x] T1.3 Nagrywanie w rendererze (`getUserMedia` + `MediaRecorder` webm/opus), miernik poziomu, pigułka nagrywania
- [x] T1.4 Uprawnienia do mikrofonu (handler uprawnień sesji, `askForMediaAccess` na macOS)
- [x] T1.5 Limit długości nagrania (90 s) jako zabezpieczenie przed zgubionym puszczeniem klawisza
- [x] T1.6 Tryb „bez trzymania”: pozycja w menu i `quick-ask --toggle` (dla Linux Wayland)

### M2: OpenRouter
- [x] T2.1 Transkrypcja (`/audio/transcriptions`, podpowiedź języka)
- [x] T2.2 Czat ze streamingiem (SSE), prompt systemowy z datą, godziną i długością odpowiedzi
- [x] T2.3 Filtr ciszy i halucynacji Whispera („Napisy stworzone przez społeczność Amara.org” itp.)
- [x] T2.4 Czytelne błędy: zły klucz (401), brak środków (402), limit (429), brak sieci, niedostępny model, zerwane połączenie; limity czasu transkrypcji (45 s) i ciszy w streamie (30 s)
- [x] T2.5 Nowa rozmowa przerywa zapytania poprzedniej (AbortController); zamknięcie panelu nie przerywa, więc „Wróć do ostatniej rozmowy” pokaże całą odpowiedź
- [ ] T2.6 Test end-to-end z prawdziwym kluczem na Windows (nagranie → transkrypcja → odpowiedź)
- [x] T2.7 Nagrywanie do WAV 16 kHz przez AudioWorklet (zgodność z każdym modelem transkrypcji)
- [x] T2.8 Czasy pod odpowiedzią: transkrypcja i pierwszy token odpowiedzi, z nazwami modeli
- [x] T2.9 Modele transkrypcji: Grok STT (xAI) i Deepgram Nova-3
- [x] T2.10 Koszt i tokeny: `usage` z transkrypcji, odpowiedzi i generowania obrazów, pod każdą odpowiedzią, suma rozmowy w nagłówku panelu i w historii
- [x] T2.11 Wyszukiwanie w internecie: narzędzie `openrouter:web_search` (model sam decyduje), przełącznik „Szukaj w internecie” w menu, lista źródeł pod odpowiedzią; model bez obsługi narzędzi odpowiada bez wyszukiwania

### M3: Panel odpowiedzi
- [x] T3.1 Panel: transkrypt pytania + odpowiedź przez Streamdown, dopasowanie wielkości okna do treści
- [x] T3.2 Reguła wątku + limit historii wysyłanej do modelu (10 ostatnich wymian)
- [x] T3.3 Panel nie znika sam: zamyka go tylko × (albo Esc, gdy okno jest aktywne); „Nowa rozmowa” czyści wątek; kopiowanie odpowiedzi
- [x] T3.4 Linki z odpowiedzi otwierane w przeglądarce, nigdy w overlayu
- [ ] T3.5 Natywny blur na macOS (`vibrancy`); na Windows zostaje pełne tło, bo acrylic działa tylko w aktywnym oknie
- [ ] T3.6 Zwijanie starszych pytań przy długich rozmowach
- [x] T3.7 Przeciąganie pigułki nagrywania, zapamiętane położenie, „Przywróć położenie pigułki nagrywania” w menu
- [x] T3.8 Rozmowa jako zwykłe okno aplikacji (zamiast okna zawsze na wierzchu), nasza ikona w oknach, na pasku zadań i w Docku

### M4: Ustawienia i onboarding
- [x] T4.1 Menu w zasobniku: model odpowiedzi, model transkrypcji, język, długość, klawisz, autostart, ostatnia rozmowa
- [x] T4.3 Domyślne modele na górze list (jedna grupa radio, bez sekcji „Polecane”, która w Windows i Linuksie pokazywała dwa zaznaczone modele): Gemini 3.8 Flash (szybki) i Gemini Pro (myślący, alias `~google/gemini-pro-latest`), Grok STT do transkrypcji (domyślny w nowych instalacjach)
- [x] T4.9 Wydatki w menu z `GET /api/v1/key`: dziś i łącznie, limit klucza jeśli ustawiony, „Doładuj kredyty…”; saldo całego konta wymaga klucza zarządzającego, więc go nie pokazujemy
- [x] T4.2 Okno klucza API z testem klucza (`GET /api/v1/key`) i prośbą o Accessibility na macOS
- [ ] T4.4 Onboarding przy pierwszym uruchomieniu: klucz API, test mikrofonu, uprawnienia
- [x] T4.5 Wybór mikrofonu w menu (lista urządzeń z renderera); odłączony mikrofon → domyślny systemowy
- [x] T4.8 Historia rozmów w SQLite (`node:sqlite` + Drizzle ORM, bez natywnych modułów): zapis każdej rozmowy, okno „Historia rozmów” z wyszukiwaniem, powrót do rozmowy i kontynuacja, przełącznik „Zapisuj historię”; testy: `npm run test:history`
- [ ] T4.6 „Inny model…”: okno z wyszukiwarką po `GET /api/v1/models`
- [ ] T4.7 Własny klawisz nagrywania (nagrywanie kombinacji w oknie ustawień)

### M5: Platformy i dystrybucja
- [ ] T5.1 macOS: test `type: 'panel'` nad aplikacjami pełnoekranowymi, uprawnienia mikrofonu i Accessibility na podpisanej apce
- [ ] T5.2 Windows: test na skalowaniu 125–200% i z aplikacjami uruchomionymi jako administrator
- [ ] T5.3 Linux: test na X11, instrukcja podpięcia `quick-ask --toggle` pod skrót systemowy na Waylandzie
- [x] T5.4 GitHub Actions: `ci.yml` (typecheck + build na każdy push) i `release.yml` (instalatory Windows, macOS arm64/x64, Linux po tagu `v*` jako szkic release'u); paczki macOS i Linux jeszcze niesprawdzone
- [ ] T5.5 Podpisywanie: notaryzacja Apple (Developer ID), podpis Windows (Azure Trusted Signing)
- [ ] T5.6 Auto-aktualizacje (`electron-updater` + GitHub Releases)

### M6: Po MVP
- [x] T6.2 Pisanie pytania zamiast mówienia: pole tekstowe w panelu (Enter wysyła, Shift+Enter nowa linia, Esc czyści szkic) i „Napisz pytanie…” w menu
- [x] T6.3a Obrazy jako załącznik do pytania (maks. 3): ze schowka (także skopiowane pliki), z dysku, przeciągnięte albo wklejone do panelu
- [ ] T6.3b Kontekst: zaznaczony tekst / zrzut ekranu jako załącznik do pytania
- [x] T6.7 Generowanie i edycja obrazów: model czatu wywołuje narzędzie `generate_image`, rysuje model z menu „Model obrazów” przez `POST /api/v1/images`; edycja załączonych albo ostatnio wygenerowanych obrazów; kopiuj / zapisz / otwórz; pliki w `userData/images`, sprzątane po usunięciu rozmowy
- [ ] T6.5 Tłumaczenie interfejsu (PL / EN)
- [ ] T6.6 Czytanie odpowiedzi na głos (`/api/v1/audio/speech`)

### M7: Narzędzia dla AI
- [x] T7.3 Pętla tool calling: wynik narzędzia wraca do modelu (`role: tool` z `tool_call_id`), model może wołać kolejne; najwyżej 4 rundy, potem `tool_choice: none`. `reasoning_details` wracają bez zmian (Gemini 3 bez sygnatur myśli odrzuca wynik narzędzia, Claude bez bloków thinking). `generate_image` nadal kończy odpowiedź. Użyte narzędzia nad odpowiedzią (rozwijane: wejście i wynik), zapisane w historii (kolumna `tools`); menu „Narzędzia AI” z przełącznikiem dla każdego; testy: `npm run test:tools`
- [x] T7.2 Sandbox JavaScript (`run_javascript`): [quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi) (QuickJS-NG w WASM) w `worker_thread`; bez sieci, plików, timerów i `require`; 64 MB pamięci, 5 s, świeża maszyna przy każdym uruchomieniu; zmienna `message` z całym pytaniem, więc wklejonych danych model nie przepisuje do kodu. Worker zatrzymywany po 2 min bezczynności, zabijany, gdy nie odpowiada
- [x] T7.1 Wykresy: blok ` ```vega-lite ` w odpowiedzi rysowany przez Vega-Lite (ładowany leniwie). Wyrażenia przez `vega-interpreter` (CSP bez `eval`), loader bez sieci: tylko dane z odpowiedzi, bez obrazków i linków. Paleta 8 kolorów sprawdzona pod daltonizm na tle #1E1E22
- [x] T7.4 Kursy walut (`get_exchange_rate`): średnie kursy NBP, tabela A, potem B; kurs z dnia albo ostatni przed nim; inne pary przez PLN
- [x] T7.5 Pogoda (`get_weather`): Open-Meteo, geokodowanie i prognoza do 7 dni; Open-Meteo w źródłach pod odpowiedzią (dane CC BY 4.0, darmowe do użytku niekomercyjnego)
- [x] T7.6 Strefy czasowe (`convert_time`): `Intl` z bazą tz, zmiana czasu liczona dokładnie
- [ ] T7.7 Tekst ze schowka jako załącznik do pytania, na żądanie użytkownika (przycisk / pozycja w menu), a nie jako narzędzie modelu: schowek w połączeniu z treściami z sieci pozwoliłby prompt injection wynieść dane
- [ ] T7.8 Pliki CSV / XLSX przeciągnięte do panelu jako dane dla sandboxa (papaparse; SheetJS z cdn.sheetjs.com, bo `xlsx` z npm jest porzucony i ma CVE)
- [ ] T7.9 `openrouter:web_fetch` dla linków podanych w pytaniu, z `allowed_domains` ograniczonym do ich domen
- [ ] T7.10 Sprawdzić worker i `quickjs.wasm` w spakowanej aplikacji (app.asar) na Windows, macOS i Linuksie
- Odrzucone: mathjs (sandbox JS to pokrywa, a w 2026 mathjs miał podatności z wykonaniem kodu), `node:vm` / vm2 / isolated-vm (to nie sandbox, ucieczki, moduł natywny), Pyodide (13 MB + pandas, ok. 3 s startu, kod Pythona ma dostęp do procesu przez `js`), osobne narzędzia do tłumaczenia, słownika i Wikipedii (model i wyszukiwarka wystarczą), `openrouter:datetime` (data jest w prompcie), klient MCP (duża powierzchnia ataku)
