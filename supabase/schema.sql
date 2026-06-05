create schema if not exists chatbot;

create table if not exists chatbot.volumes_diarios (
  id bigint generated always as identity primary key,
  data date not null,
  obra text not null,
  tipo text not null,
  volume numeric(14,3) not null default 0,
  quantidade integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_volumes_diarios_data on chatbot.volumes_diarios (data);
create index if not exists idx_volumes_diarios_tipo on chatbot.volumes_diarios (tipo);
create index if not exists idx_volumes_diarios_obra on chatbot.volumes_diarios (obra);

alter table chatbot.volumes_diarios enable row level security;

create table if not exists chatbot.setores_diarios (
  id bigint generated always as identity primary key,
  data date not null,
  setor text not null,
  programado_volume numeric(14,3) not null default 0,
  realizado_volume numeric(14,3) not null default 0,
  programado_quantidade integer not null default 0,
  realizado_quantidade integer not null default 0,
  programado_unidade text not null default 'm3',
  realizado_unidade text not null default 'm3',
  fonte jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint setores_diarios_data_setor_key unique (data, setor)
);

create index if not exists idx_setores_diarios_data on chatbot.setores_diarios (data);
create index if not exists idx_setores_diarios_setor on chatbot.setores_diarios (setor);

alter table chatbot.setores_diarios enable row level security;

create or replace function chatbot.get_volume_periodo(
  p_tipo text,
  p_data_inicial date,
  p_data_final date,
  p_obra text default null
)
returns table (
  tipo text,
  data_inicial date,
  data_final date,
  obra text,
  volume_total numeric,
  quantidade_total bigint
)
language plpgsql
stable
as $$
declare
  v_tipo text;
begin
  if p_data_inicial is null or p_data_final is null then
    raise exception 'p_data_inicial e p_data_final sao obrigatorias';
  end if;

  if p_data_inicial > p_data_final then
    raise exception 'Periodo invalido: p_data_inicial (%) maior que p_data_final (%)', p_data_inicial, p_data_final;
  end if;

  v_tipo := nullif(trim(p_tipo), '');

  return query
  select
    coalesce(v_tipo, 'geral') as tipo,
    p_data_inicial as data_inicial,
    p_data_final as data_final,
    p_obra as obra,
    coalesce(sum(v.volume), 0) as volume_total,
    coalesce(sum(v.quantidade), 0)::bigint as quantidade_total
  from chatbot.volumes_diarios v
  where v.data between p_data_inicial and p_data_final
    and (p_obra is null or v.obra = p_obra)
    and (v_tipo is null or v.tipo = v_tipo);
end;
$$;

create or replace function chatbot.get_volume_geral_periodo(
  p_data_inicial date,
  p_data_final date
)
returns table (
  tipo text,
  label text,
  ordem integer,
  data_inicial date,
  data_final date,
  volume_total numeric,
  quantidade_total bigint
)
language plpgsql
stable
as $$
begin
  if p_data_inicial is null or p_data_final is null then
    raise exception 'p_data_inicial e p_data_final sao obrigatorias';
  end if;

  if p_data_inicial > p_data_final then
    raise exception 'Periodo invalido: p_data_inicial (%) maior que p_data_final (%)', p_data_inicial, p_data_final;
  end if;

  return query
  with tipos(tipo, label, ordem) as (
    values
      ('projetado', 'Projetado', 1),
      ('fabricado', 'Fabricado', 2),
      ('acabado', 'Acabado', 3),
      ('expedido', 'Expedido', 4),
      ('montado', 'Montado', 5)
  ),
  volumes_base as (
    select
      case
        when v.tipo in ('projetos', 'projetado') then 'projetado'
        else v.tipo
      end as tipo,
      v.volume,
      v.quantidade
    from chatbot.volumes_diarios v
    where v.data between p_data_inicial and p_data_final
      and v.tipo in ('projetos', 'projetado', 'fabricado', 'montado')
  ),
  setores_base as (
    select
      case lower(sd.setor)
        when 'acabamento' then 'acabado'
        when 'expedicao' then 'expedido'
      end as tipo,
      sd.realizado_volume as volume,
      sd.realizado_quantidade as quantidade
    from chatbot.setores_diarios sd
    where sd.data between p_data_inicial and p_data_final
      and lower(sd.setor) in ('acabamento', 'expedicao')
  ),
  base as (
    select * from volumes_base
    union all
    select * from setores_base
  )
  select
    t.tipo,
    t.label,
    t.ordem,
    p_data_inicial,
    p_data_final,
    coalesce(sum(b.volume), 0) as volume_total,
    coalesce(sum(b.quantidade), 0)::bigint as quantidade_total
  from tipos t
  left join base b on b.tipo = t.tipo
  group by t.tipo, t.label, t.ordem
  order by t.ordem;
end;
$$;

create or replace function chatbot.get_programado_realizado_periodo(
  p_data_inicial date,
  p_data_final date,
  p_setor text default null
)
returns table (
  setor text,
  label text,
  ordem integer,
  data_inicial date,
  data_final date,
  programado_total numeric,
  realizado_total numeric,
  programado_quantidade bigint,
  realizado_quantidade bigint,
  programado_unidade text,
  realizado_unidade text
)
language plpgsql
stable
as $$
declare
  v_setor text;
begin
  if p_data_inicial is null or p_data_final is null then
    raise exception 'p_data_inicial e p_data_final sao obrigatorias';
  end if;

  if p_data_inicial > p_data_final then
    raise exception 'Periodo invalido: p_data_inicial (%) maior que p_data_final (%)', p_data_inicial, p_data_final;
  end if;

  v_setor := lower(nullif(trim(p_setor), ''));

  return query
  with setores(setor, label, ordem) as (
    values
      ('escoamento', 'Escoamento', 1),
      ('concretagem', 'Concretagem', 2),
      ('armacao', 'Armação', 3),
      ('acabamento', 'Acabamento', 4),
      ('expedicao', 'Expedição', 5),
      ('montagem', 'Montagem', 6)
  ),
  base as (
    select
      lower(sd.setor) as setor,
      sd.programado_volume,
      case when lower(sd.setor) = 'montagem' then 0 else sd.realizado_volume end as realizado_volume,
      sd.programado_quantidade,
      case when lower(sd.setor) = 'montagem' then 0 else sd.realizado_quantidade end as realizado_quantidade,
      sd.programado_unidade,
      sd.realizado_unidade
    from chatbot.setores_diarios sd
    where sd.data between p_data_inicial and p_data_final
      and (v_setor is null or lower(sd.setor) = v_setor)
    union all
    select
      'montagem' as setor,
      0::numeric as programado_volume,
      v.volume as realizado_volume,
      0::integer as programado_quantidade,
      v.quantidade as realizado_quantidade,
      'm3' as programado_unidade,
      'm3' as realizado_unidade
    from chatbot.volumes_diarios v
    where v.data between p_data_inicial and p_data_final
      and v.tipo = 'montado'
      and (v_setor is null or v_setor = 'montagem')
  )
  select
    s.setor,
    s.label,
    s.ordem,
    p_data_inicial,
    p_data_final,
    coalesce(sum(b.programado_volume), 0) as programado_total,
    coalesce(sum(b.realizado_volume), 0) as realizado_total,
    coalesce(sum(b.programado_quantidade), 0)::bigint as programado_quantidade,
    coalesce(sum(b.realizado_quantidade), 0)::bigint as realizado_quantidade,
    coalesce(max(b.programado_unidade), 'm3') as programado_unidade,
    coalesce(max(b.realizado_unidade), 'm3') as realizado_unidade
  from setores s
  left join base b on b.setor = s.setor
  where v_setor is null or s.setor = v_setor
  group by s.setor, s.label, s.ordem
  order by s.ordem;
end;
$$;

create or replace view chatbot.vw_volumes_diarios_geral as
select
  v.data,
  coalesce(sum(v.volume), 0) as volume_total,
  coalesce(sum(v.quantidade), 0)::bigint as quantidade_total
from chatbot.volumes_diarios v
group by v.data;

create or replace view chatbot.vw_setores_diarios_geral as
select
  sd.data,
  sd.setor,
  sd.programado_volume,
  sd.realizado_volume,
  sd.programado_quantidade,
  sd.realizado_quantidade,
  sd.programado_unidade,
  sd.realizado_unidade
from chatbot.setores_diarios sd;

revoke all on schema chatbot from anon, authenticated;
revoke all on table chatbot.volumes_diarios from anon, authenticated;
revoke all on sequence chatbot.volumes_diarios_id_seq from anon, authenticated;
revoke all on table chatbot.setores_diarios from anon, authenticated;
revoke all on sequence chatbot.setores_diarios_id_seq from anon, authenticated;
revoke all on function chatbot.get_volume_periodo(text, date, date, text) from anon, authenticated;
revoke all on function chatbot.get_volume_geral_periodo(date, date) from anon, authenticated;
revoke all on function chatbot.get_programado_realizado_periodo(date, date, text) from anon, authenticated;
revoke all on table chatbot.vw_volumes_diarios_geral from anon, authenticated;
revoke all on table chatbot.vw_setores_diarios_geral from anon, authenticated;

grant usage on schema chatbot to service_role;
grant select, insert, update, delete on table chatbot.volumes_diarios to service_role;
grant usage, select on sequence chatbot.volumes_diarios_id_seq to service_role;
grant select, insert, update, delete on table chatbot.setores_diarios to service_role;
grant usage, select on sequence chatbot.setores_diarios_id_seq to service_role;
grant execute on function chatbot.get_volume_periodo(text, date, date, text) to service_role;
grant execute on function chatbot.get_volume_geral_periodo(date, date) to service_role;
grant execute on function chatbot.get_programado_realizado_periodo(date, date, text) to service_role;
grant select on chatbot.vw_volumes_diarios_geral to service_role;
grant select on chatbot.vw_setores_diarios_geral to service_role;
