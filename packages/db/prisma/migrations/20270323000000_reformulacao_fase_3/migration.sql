-- Reformulação, Fase 3 — somente aditiva (nenhuma linha existente muda).

-- ============================================================ qualidade: autoaprovação do gestor
-- D4: o gestor pode aprovar a própria execução com justificativa obrigatória. NULL = aprovação
-- comum (ou inspeção ainda não decidida). Identidade e data já estão em decided_by_id/decided_at.
ALTER TABLE "quality_inspections" ADD COLUMN "self_approval_reason" VARCHAR(500);
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_self_approval" CHECK (
  "self_approval_reason" IS NULL
  OR ("status" = 'APROVADA' AND length(btrim("self_approval_reason")) >= 10));

-- ============================================================ embalagem opcional
-- Se a embalagem era exigida quando a inspeção foi aprovada (interruptor "embalagem" da Fase 0).
-- Gravado na aprovação: ligar/desligar depois não muda o que já foi decidido. As inspeções que já
-- existem ficam TRUE (o comportamento de sempre).
ALTER TABLE "quality_inspections" ADD COLUMN "packaging_required" BOOLEAN NOT NULL DEFAULT true;
