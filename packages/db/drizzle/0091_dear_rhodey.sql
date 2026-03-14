ALTER TYPE "activity_operation" ADD VALUE 'subscription_create';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'subscription_update';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'subscription_cancel';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'subscription_reactivate';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'billing_update';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'customer_create';--> statement-breakpoint
ALTER TYPE "activity_operation" ADD VALUE 'schedule_cancel';--> statement-breakpoint
ALTER TYPE "activity_resource" ADD VALUE 'subscription';