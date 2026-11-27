# Análise de viabilidade — automação de grupos de WhatsApp (WeDeals / WAPE)

Data da pesquisa: 27/11/2026. Fontes no final. Itens marcados **(confirmar)** não puderam ser
confirmados em documentação oficial e precisam ser validados pela WAPE antes de qualquer contrato.

## Pergunta central

É possível publicar ofertas **automaticamente** em **grupos convencionais grandes** do WhatsApp
(centenas/milhares de participantes que entraram por link de convite) usando uma integração **oficial**?

**Resposta: hoje, não.** A única API oficial para grupos (Meta Groups API, parte da Cloud API) limita
cada grupo a **8 participantes**. Não há API oficial documentada para Comunidades nem para Canais.
Por isso o WeDeals entra em produção com **publicação assistida** para WhatsApp, mantendo a camada de
distribuição desacoplada para plugar uma integração oficial quando existir.

## Comparativo

| Alternativa | Oficial? | Publica em grupo convencional existente? | Imagem + link | Limite de participantes | Autenticação | Custo | Estabilidade | Risco de bloqueio | Restrição contratual | Intervenção humana |
|---|---|---|---|---|---|---|---|---|---|---|
| **WhatsApp Business (app)** | Sim | Sim, manualmente pelo admin | Sim | Grupo comum (limite do app, ~1.024) | Celular do admin | Grátis | Alta | Baixo em uso manual normal | Termos do WhatsApp Business | **Total**: o admin envia |
| **Meta Cloud API (mensagens 1:1)** | Sim | **Não** (é 1:1, por template/janela de 24h) | Sim | n/a | Token Meta + número verificado | Cobrança por mensagem/template | Alta | Baixo se seguir política | Política de mensagens comerciais; opt-in obrigatório | Baixa — mas 1:1 está **fora da estratégia** do WeDeals |
| **Meta Groups API** | Sim | **Não** — só grupos criados pela própria API; não importa grupos existentes | Sim | **8 participantes** por grupo; até 10.000 grupos por número | Token Meta, número na Cloud API | Cobrança da Cloud API **(confirmar tabela)** | Alta | Baixo | Não é possível adicionar membros; entrada só por link/aprovação | Baixa, mas o limite de 8 inviabiliza grupos de promoção |
| **Comunidades do WhatsApp** | Recurso oficial do app | Avisos da comunidade, manualmente | Sim | Grupos de aviso grandes **(confirmar limite atual)** | Celular do admin | Grátis | Alta | Baixo em uso manual | Termos do WhatsApp | **Total**: sem API oficial encontrada |
| **Canais do WhatsApp** | Recurso oficial do app | Não é grupo; é broadcast unidirecional | Sim | Sem limite prático de seguidores | Celular do admin | Grátis | Alta | Baixo | Termos de Canais | **Total**: sem API pública de publicação encontrada |
| **Evolution API** | **Não** (usa protocolo do WhatsApp Web via Baileys) | Sim | Sim | Limite do grupo | Sessão por QR code | Self-host (servidor) | Média/baixa: quebra quando o WhatsApp muda o protocolo | **Alto** | Viola os Termos de Serviço do WhatsApp (automação não autorizada) | Baixa após conectar |
| **Baileys** | **Não** (engenharia reversa) | Sim | Sim | Limite do grupo | Sessão por QR | Grátis (open source) | Média/baixa | **Alto** | Viola os Termos | Baixa |
| **WPPConnect** | **Não** (automação do WhatsApp Web) | Sim | Sim | Limite do grupo | Sessão por QR | Grátis | Média/baixa | **Alto** | Viola os Termos | Baixa |
| **BSPs (360dialog, Gupshup, Twilio…)** | Parceiros oficiais da Meta | Só o que a Cloud API permite (Groups API = 8) | Sim | 8 | Conta no BSP | Mensalidade + mensagens | Alta | Baixo | Termos do BSP + Meta | Igual à Cloud API |
| **Telegram Bot API (complementar)** | Sim | Sim, em grupos/canais onde o bot é admin | Sim | Canais sem limite de inscritos | Token do BotFather | Grátis | Alta | Baixo, respeitando limites | Termos do Telegram | **Nenhuma** |

## Decisão técnica recomendada

1. **WhatsApp = publicação assistida** (implementado): o Mega Brain prepara cada mensagem
   (texto, imagem autorizada, link de afiliado rastreável), já agendada para o grupo certo. O admin abre
   a central, toca em **Copiar / Compartilhar** e confirma **"Publicado"**. Um envio leva poucos segundos.
2. **Telegram = automático** (implementado com trava `PUBLISH_ENABLED=false` por padrão).
3. **Provedores não oficiais (Evolution/Baileys/WPPConnect): não implementados.** A interface
   `DistributionChannel` permite adicionar um, mas isso só deve acontecer com aprovação expressa e por
   escrito da WAPE, ciente do risco de banimento dos números e de violação dos Termos. Não há nem haverá
   código de evasão de bloqueios (rotação de números, "aquecimento", aleatorização para enganar detecção).
4. **Reavaliar trimestralmente** a Groups API e eventuais APIs de Canais/Comunidades. Quando uma
   integração oficial compatível surgir, basta implementar um novo `DistributionChannel`.

## Funcionalidades: automáticas × dependentes de decisão/credencial/pessoa

| Funcionalidade | Situação |
|---|---|
| Pesquisa contínua, deduplicação, histórico de preço, Deal Score, detecção de desconto falso | **100% automática** |
| Revalidação antes de publicar, fila, janelas de horário, intervalos, limite diário, anti-repetição | **100% automática** |
| Geração de mensagem (template + IA gratuita opcional, com fallback) | **100% automática** |
| Inteligência comercial e ajuste de pesos (dentro dos limites do admin) | **100% automática** |
| Busca de ofertas Shopee + link de afiliado | Automática **após** credenciais AppID/Secret do Shopee Affiliate Open API |
| Busca Mercado Livre | Automática **após** app e token OAuth no portal de desenvolvedores ML |
| Link de afiliado Mercado Livre | **Depende de pessoa**: gerador de links do painel de afiliados; o WeDeals importa e vincula |
| SHEIN (ofertas e links) | **Depende de pessoa/parceiro**: importação de links do portal SHEIN Afiliados ou de rede parceira (Awin/Lomadee — confirmar disponibilidade e API no painel) |
| Publicação no WhatsApp | **Assistida** (admin confirma cada envio) |
| Publicação no Telegram | Automática após token do bot **e** liberação `PUBLISH_ENABLED=true` |
| Comissões | Importação de relatórios (CSV) dos painéis; automática onde a API oficial fornecer |
| Contagem de cliques | Automática pelo redirecionador próprio (`/r/:codigo`), só contagem agregada, sem dados pessoais |

## Fontes

- Meta — Groups API: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/
- Meta — Groups API FAQ: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/faq/
- Meta — Invite link API: https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/groups/groups-invite-link-api
- Fórum Meta (relato de desenvolvedor, não oficial): https://developers.facebook.com/community/threads/1084199161066371/
- 360dialog — Groups: https://docs.360dialog.com/docs/messaging/groups
- Gupshup — Groups API (beta): https://docs.gupshup.io/docs/whatsapp-groups-api
- Meta — Sobre a plataforma: https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
- Wati — Canais (fonte secundária): https://www.wati.io/blog/whatsapp-channels/
