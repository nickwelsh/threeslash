<?php
namespace LaravelFixtures;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class User extends Model {
    protected function casts(): array {
        return ['is_admin' => 'boolean'];
    }

    /** @return HasMany<Post, $this> */
    public function posts(): HasMany {
        return $this->hasMany(Post::class);
    }
}

class Post extends Model {}
// ---cut---
$admins = User::query()->where('is_admin', true)->get();
// ^?
$admin = $admins->firstOrFail();
// ^?
$isAdmin = $admin->is_admin;
// ^?
$posts = $admin->posts;
// ^?
