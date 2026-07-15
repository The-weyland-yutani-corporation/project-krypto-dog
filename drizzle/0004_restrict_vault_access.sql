DROP FUNCTION IF EXISTS "public"."krypto_invoke_endpoint"(text);
--> statement-breakpoint
DO $$
DECLARE
	target_schema text;
	target_role text;
	target_role_sql text;
	relation_record record;
	column_list text;
BEGIN
	FOREACH target_role IN ARRAY ARRAY[
		'PUBLIC',
		'anon',
		'authenticated'
	]
	LOOP
		IF target_role <> 'PUBLIC'
			AND NOT EXISTS (
				SELECT 1
				FROM pg_roles
				WHERE rolname = target_role
			) THEN
			CONTINUE;
		END IF;

		target_role_sql := CASE
			WHEN target_role = 'PUBLIC' THEN 'PUBLIC'
			ELSE format('%I', target_role)
		END;

		FOREACH target_schema IN ARRAY ARRAY['krypto', 'vault']
		LOOP
			IF to_regnamespace(target_schema) IS NULL THEN
				CONTINUE;
			END IF;

			EXECUTE format(
				'REVOKE ALL ON SCHEMA %I FROM %s',
				target_schema,
				target_role_sql
			);
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %s',
				target_schema,
				target_role_sql
			);
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %s',
				target_schema,
				target_role_sql
			);
			EXECUTE format(
				'REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA %I FROM %s',
				target_schema,
				target_role_sql
			);

			FOR relation_record IN
				SELECT relation.oid, relation.relname
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace
					ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname = target_schema
					AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
			LOOP
				SELECT string_agg(format('%I', attribute.attname), ', ')
				INTO column_list
				FROM pg_attribute AS attribute
				WHERE attribute.attrelid = relation_record.oid
					AND attribute.attnum > 0
					AND NOT attribute.attisdropped;

				IF column_list IS NOT NULL THEN
					EXECUTE format(
						'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM %s',
						column_list,
						target_schema,
						relation_record.relname,
						target_role_sql
					);
				END IF;
			END LOOP;
		END LOOP;

		FOR relation_record IN
			WITH RECURSIVE protected_relation AS (
				SELECT relation.oid
				FROM pg_class AS relation
				JOIN pg_namespace AS namespace
					ON namespace.oid = relation.relnamespace
				WHERE namespace.nspname IN ('krypto', 'vault')
					AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')

				UNION

				SELECT wrapper.oid
				FROM protected_relation AS protected
				JOIN pg_depend AS dependency
					ON dependency.refobjid = protected.oid
					AND dependency.classid = 'pg_rewrite'::regclass
				JOIN pg_rewrite AS rewrite
					ON rewrite.oid = dependency.objid
				JOIN pg_class AS wrapper
					ON wrapper.oid = rewrite.ev_class
				WHERE wrapper.relkind IN ('v', 'm')
			)
			SELECT relation.oid, relation.relname
			FROM protected_relation AS protected
			JOIN pg_class AS relation
				ON relation.oid = protected.oid
			JOIN pg_namespace AS namespace
				ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = 'public'
		LOOP
			EXECUTE format(
				'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %s',
				relation_record.relname,
				target_role_sql
			);

			SELECT string_agg(format('%I', attribute.attname), ', ')
			INTO column_list
			FROM pg_attribute AS attribute
			WHERE attribute.attrelid = relation_record.oid
				AND attribute.attnum > 0
				AND NOT attribute.attisdropped;

			IF column_list IS NOT NULL THEN
				EXECUTE format(
					'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM %s',
					column_list,
					relation_record.relname,
					target_role_sql
				);
			END IF;
		END LOOP;

		FOR relation_record IN
			SELECT
				routine.oid::regprocedure::text AS signature
			FROM pg_proc AS routine
			JOIN pg_namespace AS namespace
				ON namespace.oid = routine.pronamespace
			WHERE namespace.nspname = 'public'
				AND routine.prosecdef
		LOOP
			EXECUTE format(
				'REVOKE EXECUTE ON ROUTINE %s FROM %s',
				relation_record.signature,
				target_role_sql
			);
		END LOOP;
	END LOOP;
END
$$;