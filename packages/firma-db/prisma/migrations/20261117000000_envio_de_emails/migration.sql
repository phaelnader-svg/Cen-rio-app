-- Envio dos e-mails da caixa de saída pelo Resend (convites e recuperação de senha).
-- Só acrescenta colunas; e-mails antigos que nunca saíram ficam marcados como não enviados e são
-- enviados depois que o RESEND_API_KEY for configurado (no máximo 8 tentativas cada).
ALTER TABLE "outbox_mails" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_error" VARCHAR(500),
ADD COLUMN "next_try_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "outbox_mails_sent_at_next_try_at_idx" ON "outbox_mails"("sent_at", "next_try_at");
