# Conta do administrador (gestor) — verificação, 14/11/2026, 17:26Z

- Versão ativa: `696e3e9` (etiqueta, pilha, candidata e migrada); scripts `9ff142e274b1`. ✔
- O e-mail pedido pelo dono **é** o `cenario-admin-email` dos metadados da VM. A comparação foi feita
  sem imprimir o valor. Foi com ele que o `seed_bootstrap` da fase J (17:23:52Z) criou o gestor pelo
  fluxo oficial: "✔ Gestor «mascarado» criado".
- Banco: `users` 1, `user_roles` 1, `employees` 1, `roles` 5, `role_permissions` 81, `sessions` 0
  (ninguém entrou ainda).
- O papel **Gestor** recebe sempre o catálogo completo de permissões (`packages/db/src/seed.ts`).
  Não existe conceito de "plano COMPLETE" no sistema.
- Nenhuma conta nova criada (seria duplicidade). Nada inserido manualmente no banco. A senha
  inicial está no Secret Manager (`prod-admin-password`) e não foi lida nem exibida.
- O login só pode ser confirmado pelo dono: o operador não tem acesso à senha.
