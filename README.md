# agent007-service-ts

TypeScript-версия сервиса для подключения агента из Agent Builder к Telegram-боту через Make (Integromat).

## Быстрый старт

1. Установите Node 18+ и Git.
2. Клонируйте репозиторий и установите зависимости:
   ```bash
   npm i
   cp .env.example .env
   ```
3. Поместите экспорт агента из Agent Builder в `src/agent/exported-agent.js`.
4. Запуск:
   ```bash
   npm run dev   # режим разработки (ts-node)
   npm run build && npm start   # сборка и запуск из dist/
   ```

## Эндпоинты

### POST /run
```json
{
  "chat_id": 123456,
  "text": "Привет!",
  "files": [{"name":"report.pdf","url":"https://..."}]
}
```
Ответ:
```json
{ "ok": true, "answer": "..." }
```

### GET /health
Проверка статуса.

## Подключение в Make
1. Telegram Bot · Watch updates
2. Router (ветки для текста и файла)
3. HTTP · Make a request (POST /run)
4. Telegram Bot · Send a message ({{HTTP.answer}})

## Контекст диалога
Используется `conversation_id = chat_id`.

## Замечания
- Поддерживает `web_search` и `code_interpreter`.
- Файл `fallback-agent.ts` используется по умолчанию, пока не подгружен экспорт из Agent Builder.
