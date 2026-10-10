-- Evolução, Fase 5: mão de obra dos tapeceiros — revisão financeira e unicidade.
-- Migration ADITIVA: nenhum valor, pagamento, ajuste ou obrigação existente é alterado.

-- AlterTable
ALTER TABLE "production_payables" ADD COLUMN     "review_id" UUID;
-- CreateTable
CREATE TABLE "labor_reviews" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "owner_change_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
    "reason" VARCHAR(500) NOT NULL,
    "resolution" JSONB,
    "resolution_note" VARCHAR(500),
    "opened_by_id" UUID,
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "labor_reviews_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "labor_reviews_number_key" ON "labor_reviews"("number");
-- CreateIndex
CREATE UNIQUE INDEX "labor_reviews_owner_change_id_key" ON "labor_reviews"("owner_change_id");
-- CreateIndex
CREATE INDEX "labor_reviews_status_created_at_idx" ON "labor_reviews"("status", "created_at");
-- CreateIndex
CREATE INDEX "labor_reviews_service_order_id_idx" ON "labor_reviews"("service_order_id");
-- AddForeignKey
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "labor_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_owner_change_id_fkey" FOREIGN KEY ("owner_change_id") REFERENCES "service_order_item_owner_changes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "labor_reviews"
  ADD CONSTRAINT "labor_reviews_status_check" CHECK ("status" IN ('ABERTA', 'RESOLVIDA'));

-- No máximo uma revisão ABERTA por escopo (peça, ou OS inteira quando a peça é nula).
CREATE UNIQUE INDEX "labor_reviews_one_open_per_scope"
  ON "labor_reviews" ("service_order_id", COALESCE("service_order_item_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "status" = 'ABERTA';

-- Uma obrigação viva por profissional e escopo (impede dupla obrigação mesmo sob concorrência).
-- Substitui a regra anterior "uma obrigação viva por peça/OS" (Fase 11): na substituição de
-- titular resolvida pelo gestor, quem trabalhou antes mantém o que lhe é devido e o novo titular
-- ganha obrigação própria na mesma peça. Lançamentos comuns continuam um por peça (aplicação).
-- Os dados existentes cumprem o novo índice (a regra antiga era mais restritiva).
DROP INDEX IF EXISTS "production_payables_item_active";
DROP INDEX IF EXISTS "production_payables_order_active";
CREATE UNIQUE INDEX "production_payables_one_live_per_piece_professional"
  ON "production_payables" ("service_order_item_id", "professional_user_id")
  WHERE "status" <> 'CANCELADO' AND "service_order_item_id" IS NOT NULL;
CREATE UNIQUE INDEX "production_payables_one_live_per_os_professional"
  ON "production_payables" ("service_order_id", "professional_user_id")
  WHERE "status" <> 'CANCELADO' AND "service_order_item_id" IS NULL;

-- Revisão resolvida é imutável; nenhuma revisão é apagada.
CREATE FUNCTION cenario_labor_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'RESOLVIDA' THEN
    RAISE EXCEPTION 'Revisão financeira resolvida é imutável' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "labor_reviews_guard"
  BEFORE UPDATE OR DELETE ON "labor_reviews"
  FOR EACH ROW EXECUTE FUNCTION cenario_labor_review_guard();

-- Dados legados (Fase 3): troca de titular sinalizada com mão de obra ainda viva para outra
-- pessoa vira revisão ABERTA — estado seguro que trava liberação e pagamento até o gestor
-- decidir. Nenhum valor é transferido nem rateado.
INSERT INTO "labor_reviews" ("id", "service_order_id", "service_order_item_id", "owner_change_id", "reason", "created_at")
SELECT gen_random_uuid(), s.so, s.item,
       CASE WHEN s.item IS NULL THEN NULL ELSE s.oc END,
       CASE WHEN s.item IS NULL
         THEN 'Migração: mão de obra da OS inteira e titular de peça alterado — defina o valor devido a cada profissional.'
         ELSE 'Migração: titular da peça substituído com mão de obra já combinada — defina o valor devido a cada profissional.'
       END,
       CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (p."service_order_id", p."service_order_item_id")
         p."service_order_id" AS so, p."service_order_item_id" AS item, oc."id" AS oc
  FROM "service_order_item_owner_changes" oc
  JOIN "service_order_items" i ON i."id" = oc."service_order_item_id"
  JOIN "production_payables" p
    ON p."service_order_id" = i."service_order_id"
   AND (p."service_order_item_id" = i."id" OR p."service_order_item_id" IS NULL)
   AND p."status" <> 'CANCELADO'
   AND p."professional_user_id" <> i."upholsterer_user_id"
  WHERE oc."financial_review_required"
  ORDER BY p."service_order_id", p."service_order_item_id", oc."created_at" DESC
) s;

-- Legado: valor da OS inteira com peça de outro titular (rateio não inequívoco) → revisão
-- ABERTA da OS inteira (se ainda não houver), sem replicar o valor nas peças.
INSERT INTO "labor_reviews" ("id", "service_order_id", "service_order_item_id", "reason", "created_at")
SELECT gen_random_uuid(), p."service_order_id", NULL,
       'Migração: mão de obra da OS inteira e peças com titulares diferentes — defina o valor devido a cada profissional.',
       CURRENT_TIMESTAMP
FROM "production_payables" p
WHERE p."service_order_item_id" IS NULL
  AND p."status" <> 'CANCELADO'
  AND EXISTS (
    SELECT 1 FROM "service_order_items" i
    WHERE i."service_order_id" = p."service_order_id"
      AND i."upholsterer_user_id" IS NOT NULL
      AND i."upholsterer_user_id" <> p."professional_user_id")
GROUP BY p."service_order_id"
ON CONFLICT DO NOTHING;
