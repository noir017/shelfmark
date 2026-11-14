// Command shelfmark is the bookmark server and its admin CLI.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"


	"shelfmark/internal/auth"
	"shelfmark/internal/config"
	"shelfmark/internal/core"
	"shelfmark/internal/importexport"
	"shelfmark/internal/jobs"
	"shelfmark/internal/server"
	"shelfmark/internal/store"
)

const usage = `用法:
  shelfmark [--config file] serve
  shelfmark user add <name> [--admin]
  shelfmark user list | delete <name>
  shelfmark token create <user> --name <n> --scopes api,dav
  shelfmark library list <user>
  shelfmark import <user> <slug> <file> [--mode folder|merge|replace]
  shelfmark export <user> <slug> [--format html|xbel|json] [-o file]
  shelfmark backup [-o file]
  shelfmark healthcheck
  shelfmark version
`

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	configFile := ""
	if len(args) >= 2 && (args[0] == "--config" || args[0] == "-config") {
		configFile, args = args[1], args[2:]
	} else if len(args) >= 1 && strings.HasPrefix(args[0], "--config=") {
		configFile, args = strings.TrimPrefix(args[0], "--config="), args[1:]
	}
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "shelfmark %s (%s)\n", config.Version, config.Commit)
		return nil
	case "help", "--help", "-h":
		fmt.Fprint(stdout, usage)
		return nil
	}
	cfg, err := config.Load(configFile, nil)
	if err != nil {
		return err
	}
	log := server.NewLogger(cfg, os.Stderr)
	switch cmd {
	case "serve":
		srv, err := server.New(cfg, log)
		if err != nil {
			return err
		}
		defer srv.Close()
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return srv.Run(ctx)
	case "healthcheck":
		addr := cfg.Listen
		if strings.HasPrefix(addr, ":") {
			addr = "127.0.0.1" + addr
		}
		c := &http.Client{Timeout: 5 * time.Second}
		resp, err := c.Get("http://" + addr + "/healthz")
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("healthz: HTTP %d", resp.StatusCode)
		}
		return nil
	}
	db, err := server.OpenDB(cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	svc := core.New(db, cfg, log)
	ctx := context.Background()
	switch cmd {
	case "user":
		return userCmd(ctx, svc, args, stdin, stdout)
	case "token":
		return tokenCmd(ctx, svc, args, stdout)
	case "library":
		if len(args) != 2 || args[0] != "list" {
			return errors.New("用法: shelfmark library list <user>")
		}
		u, err := store.GetUserByName(ctx, db, args[1])
		if err != nil {
			return fmt.Errorf("用户 %s 不存在", args[1])
		}
		libs, err := store.ListLibraries(ctx, db, u.ID)
		if err != nil {
			return err
		}
		counts, _ := store.LibraryCounts(ctx, db, u.ID)
		for _, l := range libs {
			fmt.Fprintf(stdout, "%s\t%s\t书签 %d\t修订 %d\n", l.Slug, l.Name, counts[l.ID][0], l.Revision)
		}
		return nil
	case "import":
		return importCmd(ctx, svc, args, stdout)
	case "export":
		return exportCmd(ctx, svc, args, stdout)
	case "backup":
		fs := flag.NewFlagSet("backup", flag.ContinueOnError)
		out := fs.String("o", "", "输出文件")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if *out == "" {
			path, err := jobs.BackupTo(ctx, db, filepath.Join(cfg.DataDir, "backups"), time.Now())
			if err != nil {
				return err
			}
			fmt.Fprintln(stdout, path)
			return nil
		}
		if err := db.Backup(ctx, *out); err != nil {
			return err
		}
		fmt.Fprintln(stdout, *out)
		return nil
	}
	return fmt.Errorf("未知命令 %q\n%s", cmd, usage)
}

// parseFlags lets flags appear after positional arguments.
func parseFlags(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) > 0 {
			pos = append(pos, args[0])
			args = args[1:]
		}
	}
	return pos, nil
}

func userCmd(ctx context.Context, svc *core.Service, args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	sub, args := args[0], args[1:]
	fs := flag.NewFlagSet("user", flag.ContinueOnError)
	admin := fs.Bool("admin", false, "管理员")
	pos, err := parseFlags(fs, args)
	if err != nil {
		return err
	}
	switch sub {
	case "list":
		users, err := store.ListUsers(ctx, svc.DB)
		if err != nil {
			return err
		}
		for _, u := range users {
			role := ""
			if u.IsAdmin {
				role = "admin"
			}
			fmt.Fprintf(stdout, "%d\t%s\t%s\n", u.ID, u.Username, role)
		}
		return nil
	case "add":
		if len(pos) != 1 {
			return errors.New(usage)
		}
		u, err := svc.CreateUser(ctx, pos[0], *admin)
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "已创建用户 %s\n", u.Username)
		return nil
	case "delete":
		if len(pos) != 1 {
			return errors.New(usage)
		}
		u, err := store.GetUserByName(ctx, svc.DB, pos[0])
		if err != nil {
			return fmt.Errorf("用户 %s 不存在", pos[0])
		}
		if err := store.DeleteUser(ctx, svc.DB, u.ID); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "已删除用户 %s\n", u.Username)
		return nil
	}
	return errors.New(usage)
}

func tokenCmd(ctx context.Context, svc *core.Service, args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "create" {
		return errors.New(usage)
	}
	fs := flag.NewFlagSet("token", flag.ContinueOnError)
	name := fs.String("name", "", "令牌名")
	scopes := fs.String("scopes", "api", "api,dav")
	pos, err := parseFlags(fs, args[1:])
	if err != nil {
		return err
	}
	if len(pos) != 1 || *name == "" {
		return errors.New("用法: shelfmark token create <user> --name <n> --scopes api,dav")
	}
	u, err := store.GetUserByName(ctx, svc.DB, pos[0])
	if err != nil {
		return fmt.Errorf("用户 %s 不存在", pos[0])
	}
	var sc []string
	for _, s := range strings.Split(*scopes, ",") {
		s = strings.TrimSpace(s)
		if s != "api" && s != "dav" {
			return fmt.Errorf("scope 只能是 api 或 dav")
		}
		sc = append(sc, s)
	}
	plain, err := auth.NewToken()
	if err != nil {
		return err
	}
	if _, err := store.CreateToken(ctx, svc.DB, u.ID, *name, sc, auth.HashSecret(plain), auth.TokenPrefix(plain), time.Now()); err != nil {
		return err
	}
	fmt.Fprintln(stdout, plain)
	return nil
}

func importCmd(ctx context.Context, svc *core.Service, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("import", flag.ContinueOnError)
	mode := fs.String("mode", importexport.ModeFolder, "folder|merge|replace")
	pos, err := parseFlags(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 3 {
		return errors.New("用法: shelfmark import <user> <slug> <file> [--mode folder|merge|replace]")
	}
	u, err := store.GetUserByName(ctx, svc.DB, pos[0])
	if err != nil {
		return fmt.Errorf("用户 %s 不存在", pos[0])
	}
	lib, _, err := svc.EnsureLibrary(ctx, u.ID, pos[1], true)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(pos[2])
	if err != nil {
		return err
	}
	format, nodes, err := importexport.Parse(data)
	if err != nil {
		return err
	}
	var result *importexport.Result
	res, err := svc.Write(ctx, lib, core.Actor{UserID: u.ID, Name: u.Username, Source: core.SourceImport}, core.WriteOpts{NoMerge: true}, func(w *core.WriteCtx) error {
		var err error
		result, err = importexport.Apply(w, nodes, *mode, "")
		return err
	})
	if err != nil {
		return err
	}
	for id, n := range result.Visits {
		store.SetVisits(ctx, svc.DB, lib.ID, id, n, nil)
	}
	fmt.Fprintf(stdout, "格式 %s：新增书签 %d、文件夹 %d，跳过重复 %d，修订 %d\n", format, result.AddedBookmarks, result.AddedFolders, result.SkippedDuplicates, res.Revision)
	return nil
}

func exportCmd(ctx context.Context, svc *core.Service, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	format := fs.String("format", "html", "html|xbel|json")
	out := fs.String("o", "", "输出文件（默认标准输出）")
	pos, err := parseFlags(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return errors.New("用法: shelfmark export <user> <slug> [--format html|xbel|json] [-o file]")
	}
	u, err := store.GetUserByName(ctx, svc.DB, pos[0])
	if err != nil {
		return fmt.Errorf("用户 %s 不存在", pos[0])
	}
	lib, err := svc.GetLibrary(ctx, u.ID, pos[1])
	if err != nil {
		return fmt.Errorf("库 %s 不存在", pos[1])
	}
	v, err := svc.LoadView(ctx, lib)
	if err != nil {
		return err
	}
	v.Tree.HighestID = max(v.Tree.HighestID, lib.HighestID)
	body, _, _, err := importexport.Export(importexport.ExportInput{Slug: lib.Slug, Name: lib.Name, Revision: lib.Revision, Tree: v.Tree, Meta: v.Meta, Now: time.Now()}, *format)
	if err != nil {
		return err
	}
	if *out == "" {
		_, err = stdout.Write(body)
		return err
	}
	return os.WriteFile(*out, body, 0o600)
}
