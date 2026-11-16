-- Módulo Orçamentos (proposta comercial com materiais automáticos). Só tabelas NOVAS: nenhuma
-- tabela existente é alterada. Independente de compras, medições, fornecedores e estoque.
--   quote_catalog_items: base de dados do orçamento (preços, logística, mão de obra, taxas,
--                        tapeceiros responsáveis);
--   quote_settings:      alíquota, nome da empresa na proposta e logotipo (uma linha);
--   quotes:              orçamentos salvos (cópia completa da proposta + O.S. do orçamento).
-- Multi-empresa: as três são dados de empresa (recebem company_id na etapa 2; quotes.number
-- passa a ser por empresa).

-- CreateTable
CREATE TABLE "quote_catalog_items" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "category" VARCHAR(20),
    "name" VARCHAR(160) NOT NULL,
    "price_cents" INTEGER,
    "unit" VARCHAR(20),
    "km" DECIMAL(10,2),
    "rate_bps" INTEGER,
    "phone" VARCHAR(40),
    "linked_item_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tax_rate_bps" INTEGER,
    "company_name_override" VARCHAR(90),
    "logo_data_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "customer_name" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(20),
    "service" VARCHAR(120) NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "work_order" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_catalog_items_kind_position_idx" ON "quote_catalog_items"("kind", "position");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_number_key" ON "quotes"("number");

-- CreateIndex
CREATE INDEX "quotes_deleted_at_created_at_idx" ON "quotes"("deleted_at", "created_at");

-- AddForeignKey
ALTER TABLE "quote_catalog_items" ADD CONSTRAINT "quote_catalog_items_linked_item_id_fkey" FOREIGN KEY ("linked_item_id") REFERENCES "quote_catalog_items"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- Valores aceitos (o cálculo depende deles).
ALTER TABLE "quote_catalog_items" ADD CONSTRAINT "quote_catalog_items_kind_check"
  CHECK ("kind" IN ('MATERIAL','LOGISTICA','MAO_TAPECEIRO','MAO_AJUDANTE','TAXA_MAQUINA','TAPECEIRO'));
ALTER TABLE "quote_catalog_items" ADD CONSTRAINT "quote_catalog_items_category_check"
  CHECK (("kind" = 'MATERIAL') = ("category" IS NOT NULL)
         AND ("category" IS NULL OR "category" IN ('Tecidos','Espumas','Insumos','Madeiramento')));
ALTER TABLE "quote_catalog_items" ADD CONSTRAINT "quote_catalog_items_values_check"
  CHECK (("price_cents" IS NULL OR "price_cents" >= 0)
         AND ("rate_bps" IS NULL OR ("rate_bps" >= 0 AND "rate_bps" < 10000))
         AND ("km" IS NULL OR "km" >= 0));
ALTER TABLE "quote_settings" ADD CONSTRAINT "quote_settings_tax_check"
  CHECK ("tax_rate_bps" IS NULL OR ("tax_rate_bps" >= 0 AND "tax_rate_bps" < 10000));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_total_check" CHECK ("total_cents" >= 0);

-- Numeração dos orçamentos começa em 10200 (como no modelo usado pela Cenário Estofados).
ALTER SEQUENCE "quotes_number_seq" START WITH 10200 RESTART WITH 10200;

-- Conteúdo inicial: a base de dados do modelo do dono (preços vazios = "a cadastrar").
INSERT INTO "quote_settings" ("id", "updated_at") VALUES (1, TIMESTAMPTZ '2027-04-13 00:00:00+00');

INSERT INTO "quote_catalog_items" ("id","kind","category","name","price_cents","unit","position","created_at","updated_at") VALUES
  (md5('orcamento:MATERIAL:1')::uuid,'MATERIAL','Tecidos','Suede',2200,'m',1,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:2')::uuid,'MATERIAL','Tecidos','Linho',3500,'m',2,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:3')::uuid,'MATERIAL','Tecidos','Corvin',4000,'m',3,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:4')::uuid,'MATERIAL','Tecidos','Aquablock',3500,'m',4,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:5')::uuid,'MATERIAL','Espumas','D33',138000,'m³',5,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:6')::uuid,'MATERIAL','Espumas','D28',110000,'m³',6,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:7')::uuid,'MATERIAL','Insumos','Cola',NULL,'un',7,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:8')::uuid,'MATERIAL','Insumos','Grampo',NULL,'un',8,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:9')::uuid,'MATERIAL','Insumos','Percinta',NULL,'m',9,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:10')::uuid,'MATERIAL','Insumos','Cordone',NULL,'m',10,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:11')::uuid,'MATERIAL','Insumos','Linha',NULL,'un',11,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:12')::uuid,'MATERIAL','Madeiramento','Sarrafo 5 cm',NULL,'m',12,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:13')::uuid,'MATERIAL','Madeiramento','Compensado',NULL,'un',13,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MATERIAL:14')::uuid,'MATERIAL','Madeiramento','MDF',NULL,'un',14,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00');

INSERT INTO "quote_catalog_items" ("id","kind","name","price_cents","km","position","created_at","updated_at") VALUES
  (md5('orcamento:LOGISTICA:1')::uuid,'LOGISTICA','São José dos Campos',NULL,20,1,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:LOGISTICA:2')::uuid,'LOGISTICA','Jacareí',NULL,30,2,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:LOGISTICA:3')::uuid,'LOGISTICA','Caçapava',NULL,30,3,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00');

INSERT INTO "quote_catalog_items" ("id","kind","name","price_cents","position","created_at","updated_at") VALUES
  (md5('orcamento:MAO_TAPECEIRO:1')::uuid,'MAO_TAPECEIRO','Sofá reto - 2 lugares',35000,1,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MAO_TAPECEIRO:2')::uuid,'MAO_TAPECEIRO','Sofá reto - 3 lugares',40000,2,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'),
  (md5('orcamento:MAO_TAPECEIRO:3')::uuid,'MAO_TAPECEIRO','Sofá retrátil - 2 lugares',40000,3,TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00');

-- Cada serviço do tapeceiro tem o serviço do ajudante correspondente (mesmo nome, preço próprio).
INSERT INTO "quote_catalog_items" ("id","kind","name","price_cents","linked_item_id","position","created_at","updated_at")
SELECT md5('orcamento:MAO_AJUDANTE:' || t."position")::uuid,'MAO_AJUDANTE',t."name",NULL,t."id",t."position",TIMESTAMPTZ '2027-04-13 00:00:00+00',TIMESTAMPTZ '2027-04-13 00:00:00+00'
FROM "quote_catalog_items" t WHERE t."kind" = 'MAO_TAPECEIRO';

INSERT INTO "quote_catalog_items" ("id","kind","name","rate_bps","position","created_at","updated_at")
SELECT md5('orcamento:TAXA_MAQUINA:' || n)::uuid,'TAXA_MAQUINA',
       CASE WHEN n = 1 THEN 'À vista' ELSE n || 'X' END,
       CASE WHEN n <= 3 THEN n * 100 ELSE NULL END,
       n, TIMESTAMPTZ '2027-04-13 00:00:00+00', TIMESTAMPTZ '2027-04-13 00:00:00+00'
FROM generate_series(1, 12) AS n;
